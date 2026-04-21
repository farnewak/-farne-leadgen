import type { AuditResult } from "../db/schema.js";
import type { Tier, IntentTier, SubTier } from "../models/audit.js";
import {
  computeSubTier,
  scoreBreakdown,
  type BreakdownEntry,
  type ScoreInput,
} from "./score.js";
import { classifyEmailGeneric } from "./email-classify.js";
import {
  STAGE1_COLUMNS,
  assertColumnOrder,
  type Stage1ResultRow,
} from "../../schemas/stage1_results.schema.js";

// FIX 13 — ExportRow is now a structural alias of Stage1ResultRow, the
// frozen 25-column contract. Column order is owned by
// schemas/stage1_results.schema.ts; this module is only responsible for
// populating the values. Any attempt to add, remove or reorder keys
// here must be accompanied by a matching schema change plus a bumped
// DB migration (SQLite + PG) and an ARCHITECTURE_MAP.md update.
export type ExportRow = Stage1ResultRow;

// Re-export the frozen column order so existing imports keep working.
// `EXPORT_COLUMNS` is the CSV header and drives serialization order.
export const EXPORT_COLUMNS = STAGE1_COLUMNS;

// Re-export a few types for external consumers (tests and CLIs that
// build/assert on ExportRow directly).
export type { Tier, IntentTier, SubTier, BreakdownEntry };

export interface ExportFilterOptions {
  // `null` means "no filter" — different from an empty array, which would
  // match nothing. Applies to tiers and plzList.
  tiers: Tier[] | null;
  plzList: string[] | null;
  minScore: number;
  maxScore: number;
  limit: number | null;
}

export function filterRows(
  rows: ExportRow[],
  opts: ExportFilterOptions,
): ExportRow[] {
  const filtered = rows.filter((r) => {
    if (opts.tiers && !opts.tiers.includes(r.tier)) return false;
    if (opts.plzList) {
      if (r.plz === null || !opts.plzList.includes(r.plz)) return false;
    }
    // Null score = audit-error row; those never satisfy a score-window
    // filter regardless of min/max. Outreach flows want scorable rows.
    if (r.score === null) return false;
    if (r.score < opts.minScore) return false;
    if (r.score > opts.maxScore) return false;
    return true;
  });
  const sorted = sortRows(filtered);
  return opts.limit !== null ? sorted.slice(0, opts.limit) : sorted;
}

// Stable sort: score DESC, then audited_at DESC. Business-invariant: "hotter
// lead first". No optional sort direction — tuning happens in the scorer, not
// in export flags. Null scores sort to the bottom of the list.
export function sortRows(rows: ExportRow[]): ExportRow[] {
  return [...rows].sort((a, b) => {
    const as = a.score ?? -Infinity;
    const bs = b.score ?? -Infinity;
    if (as !== bs) return bs - as;
    return b.audited_at.getTime() - a.audited_at.getTime();
  });
}

const BOM = "\uFEFF";
const CRLF = "\r\n";
const SEP = ";";

// RFC 4180 quoting + EU-Excel concessions: any of ; " \r \n forces quotes;
// embedded " is doubled. Commas are not a separator so they don't force quotes.
function csvEscape(v: string): string {
  if (/[;"\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function formatBreakdown(entries: BreakdownEntry[]): string {
  return entries
    .map((e) => {
      const sign = e.delta >= 0 ? "+" : "";
      return `${e.key}${sign}${e.delta}`;
    })
    .join("; ");
}

function toCsvCell(val: unknown): string {
  if (val === null || val === undefined) return "";
  if (val instanceof Date) return val.toISOString().slice(0, 10);
  if (typeof val === "boolean") return val ? "1" : "0";
  if (typeof val === "number") return String(val);
  if (Array.isArray(val)) {
    // score_breakdown — array of BreakdownEntry objects.
    if (
      val.length > 0 &&
      typeof val[0] === "object" &&
      val[0] !== null &&
      "key" in (val[0] as object)
    ) {
      return csvEscape(formatBreakdown(val as BreakdownEntry[]));
    }
    return csvEscape(val.join(","));
  }
  if (typeof val === "string") return csvEscape(val);
  return "";
}

export function toCsv(rows: ExportRow[]): string {
  // Header is sourced from the frozen schema (STAGE1_COLUMNS) so CSV
  // output and the TS contract can never drift.
  const header = STAGE1_COLUMNS.map((c) => csvEscape(String(c))).join(SEP);
  const body = rows.map((r) =>
    STAGE1_COLUMNS.map((c) => toCsvCell(r[c])).join(SEP),
  );
  return BOM + [header, ...body].join(CRLF) + CRLF;
}

// JSON export: ISO dates, real booleans/nulls (not 1/0 or empty strings).
// score_breakdown stays structured — consumers can diff deltas programmatically.
// Key order mirrors STAGE1_COLUMNS via sequential assignment.
export function toJson(rows: ExportRow[]): string {
  const out = rows.map((r) => {
    const obj: Record<string, unknown> = {};
    for (const key of STAGE1_COLUMNS) {
      const value = r[key];
      obj[key] =
        value instanceof Date ? value.toISOString().slice(0, 10) : value;
    }
    return obj;
  });
  return JSON.stringify(out, null, 2);
}

// Name-fallback: "www.sixta-restaurant.com" → "Sixta-Restaurant".
// Strips the leading "www.", picks the first host label, title-cases each
// dash-segment. Returns "" when the URL is missing or unparseable — caller
// is expected to pass a non-empty impressumCompanyName first.
export function hostnameFallback(url: string | null): string {
  if (!url) return "";
  try {
    const host = new URL(url).host.replace(/^www\./, "");
    const label = host.split(".")[0] ?? "";
    return label
      .split("-")
      .map((seg) =>
        seg.length > 0 ? seg[0]!.toUpperCase() + seg.slice(1).toLowerCase() : "",
      )
      .join("-");
  } catch {
    return "";
  }
}

// PLZ-extraction mirrors the Vienna-strict regex used elsewhere in the
// pipeline (osm-overpass, google-places). Non-Vienna PLZs in an
// impressum_address return null, not the raw match.
export function extractPlzFromAddress(address: string | null): string | null {
  if (!address) return null;
  const m = address.match(/\b(1\d{2}0)\b/);
  return m?.[1] ?? null;
}

function rebuildScoreInput(row: AuditResult): ScoreInput {
  // #22: hasStructuredData is now persisted on audit_results. Legacy rows
  // pre-migration carry null; coerce to `false` so their breakdown stays
  // stable (the mismatch-warn surfaces any remaining gap as "unexplained").
  return {
    tier: row.tier,
    sslValid: row.sslValid,
    httpToHttpsRedirect: row.httpToHttpsRedirect,
    hasViewportMeta: row.hasViewportMeta,
    psiMobilePerformance: row.psiMobilePerformance,
    impressumPresent: row.impressumPresent,
    impressumComplete: row.impressumComplete,
    impressumUid: row.impressumUid,
    techStack: row.techStack,
    socialLinks: row.socialLinks,
    hasStructuredData: row.hasStructuredData ?? false,
    intentTier: row.intentTier,
  };
}

function clampScore(sum: number): number {
  return Math.max(0, Math.min(30, sum));
}

export interface RowToExportShapeOptions {
  // Injectable so tests can capture warnings without touching real stderr.
  warn?: (msg: string) => void;
}

// Intent-tier values that are permitted to co-exist with tier='C'. `null`
// is also permitted (legacy / not-yet-classified error rows). PARKED is
// included as a business-meaning label: a C-row flagged as a registered
// parking page; score is allowed to carry the DOMAIN_REGISTERED_NO_SITE
// bonus rather than being nulled out.
const TIER_C_ALLOWED_INTENT_TIERS = new Set<string>([
  "AUDIT_ERROR",
  "TIMEOUT",
  "PARKED",
]);

// Intent-tier labels used for audit-error rows. These are the only
// intent-tier values that are permitted to pair with a null score.
const AUDIT_ERROR_INTENT_TIERS = new Set<string>(["AUDIT_ERROR", "TIMEOUT"]);

function assertExportInvariants(row: AuditResult): void {
  const id = row.placeId;
  // (1) score non-null implies tier non-null. tier is typed as Tier so
  // this is vacuous at the type level; the runtime check guards against
  // a DB row with a NULL tier column sneaking through.
  if (row.score !== null && !row.tier) {
    throw new Error(
      `export invariant violated (row ${id}): score=${row.score} but tier is null`,
    );
  }
  // (2) intent_tier non-null implies score non-null, unless the intent
  // tier is an explicit audit-error label.
  if (
    row.intentTier !== null &&
    row.score === null &&
    !AUDIT_ERROR_INTENT_TIERS.has(row.intentTier)
  ) {
    throw new Error(
      `export invariant violated (row ${id}): intent_tier=${row.intentTier} but score=null`,
    );
  }
  // (3) tier='C' constrains intent_tier to {null} ∪ allowed labels. Any
  // other value on a C row is a data bug — callers should have picked a
  // non-C tier (e.g. B3 with intent_tier=DEAD_WEBSITE per FIX 4).
  if (row.tier === "C") {
    if (
      row.intentTier !== null &&
      !TIER_C_ALLOWED_INTENT_TIERS.has(row.intentTier)
    ) {
      throw new Error(
        `export invariant violated (row ${id}): tier='C' but intent_tier='${row.intentTier}' is not an allowed audit-error label`,
      );
    }
    // (4) tier='C' with an error-label (or null) must carry a null
    // score. Only PARKED is allowed to carry a numeric score on a C row.
    if (
      (row.intentTier === null ||
        AUDIT_ERROR_INTENT_TIERS.has(row.intentTier ?? "")) &&
      row.score !== null
    ) {
      throw new Error(
        `export invariant violated (row ${id}): tier='C' with intent_tier=${row.intentTier ?? "null"} must have score=null (got ${row.score})`,
      );
    }
  }
  // FIX 6 (chain-apex dedupe) invariants. Collapsed canonical rows
  // (chain_detected=true) MUST carry a non-null chain_name (the apex
  // eTLD+1) and branch_count >= 2 (a "collapse" with only 1 branch is a
  // pipeline bug — it should have been a drop or pass-through). Non-
  // collapsed rows (chain_detected=false) MUST carry chain_name=null
  // and branch_count=1 so the two states stay disjoint in downstream
  // filters.
  if (!Number.isInteger(row.branchCount) || row.branchCount < 1) {
    throw new Error(
      `export invariant violated (row ${id}): branch_count must be an integer >= 1 (got ${row.branchCount})`,
    );
  }
  if (row.chainDetected) {
    if (row.chainName === null) {
      throw new Error(
        `export invariant violated (row ${id}): chain_detected=true but chain_name is null`,
      );
    }
    if (row.branchCount < 2) {
      throw new Error(
        `export invariant violated (row ${id}): chain_detected=true but branch_count=${row.branchCount} (expected >= 2)`,
      );
    }
  } else {
    if (row.chainName !== null) {
      throw new Error(
        `export invariant violated (row ${id}): chain_detected=false but chain_name='${row.chainName}' (expected null)`,
      );
    }
    if (row.branchCount !== 1) {
      throw new Error(
        `export invariant violated (row ${id}): chain_detected=false but branch_count=${row.branchCount} (expected 1)`,
      );
    }
  }
  // FIX 11 — last_modified_signal must be null OR an integer within
  // [MIN_YEAR, current_UTC_year + 1]. The detector already enforces this
  // at write-time; re-check on export so a manually-tampered DB row can't
  // surface a malformed year ("1999.5", "2099") into the CSV.
  const lms = row.lastModifiedSignal;
  if (lms !== null) {
    const maxYear = new Date().getUTCFullYear() + 1;
    if (!Number.isInteger(lms) || lms < 1995 || lms > maxYear) {
      throw new Error(
        `export invariant violated (row ${id}): last_modified_signal=${lms} outside [1995, ${maxYear}]`,
      );
    }
  }
  // FIX 8 — sub_tier invariants. Disjoint states:
  //   sub_tier ∈ {A1,A2,A3} ⇒ tier === 'A'
  //   sub_tier === null     ⇒ tier ∈ {B1,B2,B3,C}
  // Since sub_tier is derived from (tier, score) via computeSubTier,
  // these hold by construction — the check guards against future drift.
  const sub = computeSubTier(row.tier, row.score);
  if (sub !== null && row.tier !== "A") {
    throw new Error(
      `export invariant violated (row ${id}): sub_tier=${sub} requires tier='A' (got '${row.tier}')`,
    );
  }
  if (sub === null && row.tier === "A" && row.score !== null) {
    throw new Error(
      `export invariant violated (row ${id}): tier='A' with score=${row.score} must have a sub_tier (got null)`,
    );
  }
}

export function rowToExportShape(
  row: AuditResult,
  opts: RowToExportShapeOptions = {},
): ExportRow {
  assertExportInvariants(row);

  const name = row.impressumCompanyName ?? hostnameFallback(row.discoveredUrl);
  const email = row.impressumEmail;
  const emailIsGeneric = classifyEmailGeneric(email);
  // FIX 9 invariants (tautological by construction — guard against drift).
  if (emailIsGeneric !== null && email === null) {
    throw new Error(
      `export invariant violated (row ${row.placeId}): email_is_generic=${emailIsGeneric} requires a non-null email`,
    );
  }
  if (emailIsGeneric === null && email !== null && email.includes("@")) {
    // Email exists and has an @ — classification must be 0 or 1, never null.
    // (A malformed email without @ is allowed to classify as null.)
    throw new Error(
      `export invariant violated (row ${row.placeId}): email='${email}' but email_is_generic=null`,
    );
  }
  const plz = extractPlzFromAddress(row.impressumAddress);

  const input = rebuildScoreInput(row);
  const breakdown = scoreBreakdown(input);
  const recomputed = clampScore(breakdown.reduce((s, e) => s + e.delta, 0));

  // #22: has_structured_data is persisted, so scoreBreakdown() already emits
  // HAS_STRUCTURED_DATA when appropriate — no export-time inference needed.
  // Any remaining mismatch is a genuine data bug (hand-forged row, schema
  // drift, or pre-#22 legacy row with hasStructuredData=null where the
  // auditor used true). Surface it as "(unexplained)" so operators notice.
  if (row.score !== null && row.score !== recomputed) {
    const msg = `WARN export: row ${row.placeId} score mismatch stored=${row.score} recomputed=${recomputed} (unexplained)`;
    if (opts.warn) opts.warn(msg);
    else process.stderr.write(`${msg}\n`);
  }

  // Build the row in EXACTLY the frozen column order (FIX 13). The key
  // sequence below must match STAGE1_COLUMNS 1:1; `assertColumnOrder`
  // below throws if it doesn't.
  const out: ExportRow = {
    place_id: row.placeId,
    tier: row.tier,
    sub_tier: computeSubTier(row.tier, row.score),
    intent_tier: row.intentTier,
    chain_detected: row.chainDetected,
    chain_name: row.chainName,
    branch_count: row.branchCount,
    // Serializer emits score AS STORED. Any upstream bug that left score
    // null must be visible here — the prior `?? recomputed` fallback hid
    // exactly that kind of defect (see Phase 1 regression R3).
    score: row.score,
    name,
    url: row.discoveredUrl,
    phone: row.impressumPhone,
    email,
    email_is_generic: emailIsGeneric,
    address: row.impressumAddress,
    plz,
    uid: row.impressumUid,
    impressum_complete: row.impressumComplete,
    psi_mobile_performance: row.psiMobilePerformance,
    ssl_valid: row.sslValid,
    cms: row.techStack.cms.join(","),
    has_structured_data: row.hasStructuredData,
    last_modified_signal: row.lastModifiedSignal,
    has_social: Object.keys(row.socialLinks).length > 0,
    audited_at: row.auditedAt,
    score_breakdown: breakdown,
  };

  // FIX 13 — column-order integrity check. Keys MUST equal STAGE1_COLUMNS
  // in sequence; violations throw with the exact index + key delta so
  // schema drift surfaces at the earliest opportunity.
  assertColumnOrder(out as unknown as Record<string, unknown>, row.placeId);

  return out;
}
