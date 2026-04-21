import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { UpsertAuditInput } from "../db/audit-cache.js";
import { makeLogger } from "../lib/logger.js";

const log = makeLogger("url-dedupe");

// FIX 12 — URL-level duplicate detection. Runs AFTER chain-apex-dedupe and
// BEFORE DB upsert/serialization. Two leads reaching the same normalized
// URL are almost always the same business surfaced by two OSM nodes, two
// discovery passes, or OSM + Google-Places enrichment. Collapse them to a
// single row so outreach doesn't hit the same owner twice.

// Tracking-param names that carry zero site-identity signal. All utm_* are
// dropped via prefix; the rest match by exact lowercased name. Kept short
// on purpose — adding "ref" or "source" would drop legitimate page state.
const TRACKING_PARAMS_EXACT = new Set<string>([
  "gclid",
  "fbclid",
  "mc_eid",
  "mc_cid",
  "yclid",
  "_hsenc",
  "_hsmi",
]);

function stripTrackingParams(params: URLSearchParams): URLSearchParams {
  const keep = new URLSearchParams();
  for (const [key, value] of params) {
    const lower = key.toLowerCase();
    if (lower.startsWith("utm_")) continue;
    if (TRACKING_PARAMS_EXACT.has(lower)) continue;
    keep.append(key, value);
  }
  return keep;
}

// Normalizes a URL for dedupe-comparison. Returns null for unparseable
// input so callers can pass the row through untouched rather than
// collapsing "invalid" → "invalid" buckets.
export function normalizeUrlForDedupe(raw: string | null): string | null {
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  // URL.host already lowercases, but `new URL()` does not punycode-encode
  // an IDN host that was passed as a string — it leaves it in native
  // unicode on the hostname property. Reading via `host` triggers the
  // WHATWG IDN → ASCII conversion, which is what we want for dedupe keys.
  let host = parsed.host.toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);
  const pathname =
    parsed.pathname.length > 1 && parsed.pathname.endsWith("/")
      ? parsed.pathname.slice(0, -1)
      : parsed.pathname === "/"
        ? ""
        : parsed.pathname;
  const params = stripTrackingParams(parsed.searchParams);
  const qs = params.toString();
  const query = qs.length > 0 ? `?${qs}` : "";
  return `${parsed.protocol}//${host}${pathname}${query}`;
}

export interface UrlDedupeOptions {
  // Directory where logs/duplicate_urls.csv lands. Tests redirect to tmp.
  logDir: string;
  // Injectable clock for deterministic tests.
  now?: () => Date;
}

export interface UrlDedupeResult {
  survivors: UpsertAuditInput[];
  droppedCount: number;
}

const DUPLICATE_CSV_HEADER =
  "kept_place_id,dropped_place_id,normalized_url,kept_score,dropped_score,duplicate_reason,filtered_at";

function csvEscape(v: string): string {
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

interface DuplicateLogEntry {
  kept_place_id: string;
  dropped_place_id: string;
  normalized_url: string;
  kept_score: number | null;
  dropped_score: number | null;
  duplicate_reason: string;
  filtered_at: Date;
}

function appendDuplicateLog(entry: DuplicateLogEntry, csvPath: string): void {
  const dir = dirname(csvPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const needsHeader = !existsSync(csvPath);
  const line = [
    entry.kept_place_id,
    entry.dropped_place_id,
    entry.normalized_url,
    entry.kept_score === null ? "" : String(entry.kept_score),
    entry.dropped_score === null ? "" : String(entry.dropped_score),
    entry.duplicate_reason,
    entry.filtered_at.toISOString(),
  ]
    .map(csvEscape)
    .join(",");
  const body = needsHeader
    ? `${DUPLICATE_CSV_HEADER}\n${line}\n`
    : `${line}\n`;
  appendFileSync(csvPath, body, "utf-8");
}

// Comparator: higher score wins; ties resolved by earlier audited_at.
// Null score loses against any numeric score. Two nulls fall back to
// audited_at. Returns <0 when `a` should be kept, >0 when `b` should
// be kept, 0 on exact equivalence.
function compareForKeep(a: UpsertAuditInput, b: UpsertAuditInput): number {
  const aScore = a.score ?? -Infinity;
  const bScore = b.score ?? -Infinity;
  if (aScore !== bScore) return bScore - aScore;
  return a.auditedAt.getTime() - b.auditedAt.getTime();
}

export function dedupeByNormalizedUrl(
  rows: UpsertAuditInput[],
  options: UrlDedupeOptions,
): UrlDedupeResult {
  const now = options.now ?? (() => new Date());
  const csvPath = resolve(options.logDir, "duplicate_urls.csv");

  // Group by normalized URL. Rows with null URL (B1/B2/B3) pass through
  // untouched — deduping on null would collapse every B3 row into one.
  const groups = new Map<string, UpsertAuditInput[]>();
  const passThrough: UpsertAuditInput[] = [];
  for (const row of rows) {
    const key = normalizeUrlForDedupe(row.discoveredUrl);
    if (key === null) {
      passThrough.push(row);
      continue;
    }
    const bucket = groups.get(key);
    if (bucket) bucket.push(row);
    else groups.set(key, [row]);
  }

  const survivors: UpsertAuditInput[] = [...passThrough];
  let droppedCount = 0;

  for (const [normalizedUrl, group] of groups) {
    if (group.length === 1) {
      survivors.push(group[0]!);
      continue;
    }
    const ordered = [...group].sort(compareForKeep);
    const keeper = ordered[0]!;
    survivors.push(keeper);
    for (let i = 1; i < ordered.length; i++) {
      const dropped = ordered[i]!;
      appendDuplicateLog(
        {
          kept_place_id: keeper.placeId,
          dropped_place_id: dropped.placeId,
          normalized_url: normalizedUrl,
          kept_score: keeper.score,
          dropped_score: dropped.score,
          duplicate_reason: "same_normalized_url",
          filtered_at: now(),
        },
        csvPath,
      );
      droppedCount += 1;
    }
    log.info(
      `url-dedupe: collapsed ${group.length} rows on ${normalizedUrl} (kept=${keeper.placeId})`,
    );
  }

  return { survivors, droppedCount };
}

export const DUPLICATE_URLS_CSV_HEADER = DUPLICATE_CSV_HEADER;
