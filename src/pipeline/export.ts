import type { AuditResult } from "../db/schema.js";
import type { Tier, IntentTier } from "../models/audit.js";
import {
  scoreBreakdown,
  type BreakdownEntry,
  type ScoreInput,
} from "./score.js";

// Flat export-shape. Column order here is NOT authoritative — EXPORT_COLUMNS is.
// JSON-serialisers may or may not preserve insertion order, which is why the
// CSV path iterates EXPORT_COLUMNS explicitly instead of Object.keys(row).
export interface ExportRow {
  place_id: string;
  tier: Tier;
  intent_tier: IntentTier | null;
  score: number;
  name: string;
  url: string | null;
  phone: string | null;
  email: string | null;
  email_is_generic: boolean;
  address: string | null;
  plz: string | null;
  uid: string | null;
  impressum_complete: boolean | null;
  // Contact-coverage flag: union of channels present on the row.
  // "" = no channel, "P" = phone only, "E" = email only, "A" = address only,
  // "PEA" = all three. Drives outreach targeting (≥PEA rows are ready for
  // cold mail + cold call + drop-in visit).
  coverage: "" | "P" | "E" | "A" | "PE" | "PA" | "EA" | "PEA";
  psi_mobile_performance: number | null;
  ssl_valid: boolean | null;
  cms: string;
  has_social: boolean;
  audited_at: Date;
  score_breakdown: BreakdownEntry[];
}

// Column order is the CSV header row and drives the iteration in toCsv().
// Keep this in sync with the ExportRow keys — a runtime check would catch
// drift but a type-level check keeps it cheap.
export const EXPORT_COLUMNS: ReadonlyArray<keyof ExportRow> = [
  "place_id",
  "tier",
  "intent_tier",
  "score",
  "name",
  "url",
  "phone",
  "email",
  "email_is_generic",
  "address",
  "plz",
  "uid",
  "impressum_complete",
  "coverage",
  "psi_mobile_performance",
  "ssl_valid",
  "cms",
  "has_social",
  "audited_at",
  "score_breakdown",
] as const;

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
    if (r.score < opts.minScore) return false;
    if (r.score > opts.maxScore) return false;
    return true;
  });
  const sorted = sortRows(filtered);
  return opts.limit !== null ? sorted.slice(0, opts.limit) : sorted;
}

// Stable sort: score DESC, then audited_at DESC. Business-invariant: "hotter
// lead first". No optional sort direction — tuning happens in the scorer, not
// in export flags.
export function sortRows(rows: ExportRow[]): ExportRow[] {
  return [...rows].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
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
  const header = EXPORT_COLUMNS.map((c) => csvEscape(String(c))).join(SEP);
  const body = rows.map((r) =>
    EXPORT_COLUMNS.map((c) => toCsvCell(r[c])).join(SEP),
  );
  return BOM + [header, ...body].join(CRLF) + CRLF;
}

// JSON export: ISO dates, real booleans/nulls (not 1/0 or empty strings).
// score_breakdown stays structured — consumers can diff deltas programmatically.
export function toJson(rows: ExportRow[]): string {
  const out = rows.map((r) => ({
    place_id: r.place_id,
    tier: r.tier,
    intent_tier: r.intent_tier,
    score: r.score,
    name: r.name,
    url: r.url,
    phone: r.phone,
    email: r.email,
    email_is_generic: r.email_is_generic,
    address: r.address,
    plz: r.plz,
    uid: r.uid,
    impressum_complete: r.impressum_complete,
    coverage: r.coverage,
    psi_mobile_performance: r.psi_mobile_performance,
    ssl_valid: r.ssl_valid,
    cms: r.cms,
    has_social: r.has_social,
    audited_at: r.audited_at.toISOString().slice(0, 10),
    score_breakdown: r.score_breakdown,
  }));
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
  // hasStructuredData is computed at audit-time but not persisted on
  // audit_results — see src/db/schema.sqlite.ts. The rebuild therefore
  // assumes `false`, which means HAS_STRUCTURED_DATA-1 will be absent from
  // the breakdown for rows where the signal WAS present at audit time.
  // The mismatch-warn in rowToExportShape surfaces this as "stored < recomputed".
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
    hasStructuredData: false,
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

export function rowToExportShape(
  row: AuditResult,
  opts: RowToExportShapeOptions = {},
): ExportRow {
  const name = row.impressumCompanyName ?? hostnameFallback(row.discoveredUrl);
  const email = row.impressumEmail;
  const emailIsGeneric = email !== null && row.genericEmails.includes(email);
  const plz = extractPlzFromAddress(row.impressumAddress);

  const input = rebuildScoreInput(row);
  const breakdown = scoreBreakdown(input);
  const recomputed = clampScore(breakdown.reduce((s, e) => s + e.delta, 0));

  // HAS_STRUCTURED_DATA inference. rebuildScoreInput() assumes
  // hasStructuredData=false (the signal is not persisted on audit_results),
  // so any row audited with structured-data detection will show
  // recomputed = stored + 1. HAS_STRUCTURED_DATA is the ONLY -1-weighted
  // signal that is not schema-persisted (PSI_EXCELLENT rebuilds from
  // psi_mobile_performance). A gap of exactly +1 is therefore
  // mathematically unambiguous — inject the entry so breakdown sums match
  // the stored score, and suppress the WARN for this specific case.
  //
  // When has_structured_data is migrated into audit_results (open-work-
  // item #22), remove this inference block and add the column to
  // rebuildScoreInput() instead.
  if (row.score !== null && recomputed - row.score === 1) {
    breakdown.push({
      key: "HAS_STRUCTURED_DATA",
      delta: -1,
    });
  } else if (row.score !== null && row.score !== recomputed) {
    const msg = `WARN export: row ${row.placeId} score mismatch stored=${row.score} recomputed=${recomputed} (unexplained)`;
    if (opts.warn) opts.warn(msg);
    else process.stderr.write(`${msg}\n`);
  }

  return {
    place_id: row.placeId,
    tier: row.tier,
    intent_tier: row.intentTier,
    // stored score has precedence; fall back to recomputed when absent
    // (e.g. historical error rows where score was never populated).
    score: row.score ?? recomputed,
    name,
    url: row.discoveredUrl,
    phone: row.impressumPhone,
    email,
    email_is_generic: emailIsGeneric,
    address: row.impressumAddress,
    plz,
    uid: row.impressumUid,
    impressum_complete: row.impressumComplete,
    coverage: buildCoverage(row.impressumPhone, email, row.impressumAddress),
    psi_mobile_performance: row.psiMobilePerformance,
    ssl_valid: row.sslValid,
    cms: row.techStack.cms.join(","),
    has_social: Object.keys(row.socialLinks).length > 0,
    audited_at: row.auditedAt,
    score_breakdown: breakdown,
  };
}

// Derives the Coverage flag from the three persisted contact channels.
// Matches the enum defined on ExportRow. Order P → E → A is fixed so
// "PE" / "PA" / "EA" / "PEA" string-compare to the same buckets across
// different row generators.
export function buildCoverage(
  phone: string | null,
  email: string | null,
  address: string | null,
): ExportRow["coverage"] {
  const p = phone ? "P" : "";
  const e = email ? "E" : "";
  const a = address ? "A" : "";
  return (p + e + a) as ExportRow["coverage"];
}
