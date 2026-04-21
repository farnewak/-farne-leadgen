// FIX 11 — last_modified_signal detector. Three-step cascade; first non-null
// year wins. Every step is fail-safe: an exception inside a step swallows
// and returns null so the rest of the pipeline still runs. The result is
// informational (no direct scoring impact) — Phase 7 will use it to
// segment addressable markets by site freshness.
//
//   (1) Footer copyright regex. Scans the body for "© yyyy" or
//       "© yyyy-yyyy" patterns. Range takes the second year. Max across
//       all matches wins.
//   (2) HTTP Last-Modified header. Parsed via the Date constructor.
//   (3) <time datetime="..."> and <meta property="article:modified_time">
//       content attributes. Max parsed date wins.
//
// Year sanity clamp: valid range is [1995, current_year + 1]. Anything
// outside collapses to null per-match (guards against "© 2099" typos and
// test-fixture spoofing). 1995 is a generous lower bound — ca. Netscape
// era — below which a claim is almost certainly OCR/parse noise.

import { makeLogger } from "../lib/logger.js";

const log = makeLogger("last-modified-detect");

// Same budget as cms-detect / tech-stack — keep regex work bounded on
// adversarial input.
const SCAN_BYTES = 256 * 1024;

export const MIN_YEAR = 1995;

export interface DetectInput {
  body: string | null;
  headers: Record<string, string>;
  // Test hook: override "now" so the sanity clamp is deterministic.
  // Production callers leave this undefined.
  now?: Date;
}

export interface DetectResult {
  year: number | null;
}

export function detectLastModifiedYear(input: DetectInput): DetectResult {
  try {
    const now = input.now ?? new Date();
    const maxYear = now.getUTCFullYear() + 1;
    const valid = (y: number | null): number | null =>
      y !== null && Number.isInteger(y) && y >= MIN_YEAR && y <= maxYear
        ? y
        : null;

    const body = (input.body ?? "").length > SCAN_BYTES
      ? (input.body ?? "").slice(0, SCAN_BYTES)
      : input.body ?? "";

    const fromCopy = safeStep("copyright", () =>
      detectFromCopyright(body, maxYear),
    );
    if (valid(fromCopy) !== null) return { year: fromCopy };

    const fromHdr = safeStep("last-modified-header", () =>
      detectFromLastModifiedHeader(input.headers, maxYear),
    );
    if (valid(fromHdr) !== null) return { year: fromHdr };

    const fromTime = safeStep("time-tags", () =>
      detectFromTimeTags(body, maxYear),
    );
    if (valid(fromTime) !== null) return { year: fromTime };

    return { year: null };
  } catch (err) {
    log.warn(`detectLastModifiedYear failed: ${(err as Error).message}`);
    return { year: null };
  }
}

function safeStep(name: string, fn: () => number | null): number | null {
  try {
    return fn();
  } catch (err) {
    log.warn(
      `last-modified step ${name} failed: ${(err as Error).message}`,
    );
    return null;
  }
}

// ---------------------------------------------------------------- copyright
// Accepts "©", "&copy;" (HTML entity), "Copyright", "(c)", "© (c)",
// "© 2020", "© 2018-2024". The range variant is important: single-year
// sites often stay frozen at launch year, but range sites actively update
// the end year — that's the freshness signal we want.
const COPYRIGHT_RE =
  /(?:©|&copy;)\s*(?:copyright|c)?\s*\(?c?\)?\s*((?:19|20)\d{2})(?:\s*[-–]\s*((?:19|20)\d{2}))?/gi;

function detectFromCopyright(body: string, maxYear: number): number | null {
  if (!body) return null;
  let best: number | null = null;
  // Reset lastIndex defensively — the /gi flags make the RegExp stateful.
  COPYRIGHT_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = COPYRIGHT_RE.exec(body)) !== null) {
    const start = parseInt(m[1] ?? "", 10);
    const end = m[2] ? parseInt(m[2], 10) : NaN;
    const candidate = Number.isInteger(end) ? end : start;
    if (!Number.isInteger(candidate)) continue;
    if (candidate < MIN_YEAR || candidate > maxYear) continue;
    if (best === null || candidate > best) best = candidate;
  }
  return best;
}

// -------------------------------------------------------- last-modified header
// Accepts any header casing. Date constructor handles RFC 1123, ISO 8601,
// and a few other common shapes. Invalid strings produce NaN → filtered.
function detectFromLastModifiedHeader(
  headers: Record<string, string>,
  maxYear: number,
): number | null {
  if (!headers) return null;
  let raw: string | null = null;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === "last-modified") {
      raw = String(v ?? "");
      break;
    }
  }
  if (!raw) return null;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return null;
  const year = new Date(t).getUTCFullYear();
  if (!Number.isInteger(year) || year < MIN_YEAR || year > maxYear) {
    return null;
  }
  return year;
}

// ----------------------------------------------------------------- time tags
// Scans <time datetime="..."> and <meta property="article:modified_time"
// content="...">. Takes the MAX parsed year across all matches.
const TIME_ATTR_RE = /<time\s+[^>]*datetime\s*=\s*["']([^"']+)["']/gi;
const META_MODIFIED_RE =
  /<meta\s+[^>]*property\s*=\s*["']article:modified_time["'][^>]*content\s*=\s*["']([^"']+)["']/gi;
const META_MODIFIED_ALT_RE =
  /<meta\s+[^>]*content\s*=\s*["']([^"']+)["'][^>]*property\s*=\s*["']article:modified_time["']/gi;

function detectFromTimeTags(body: string, maxYear: number): number | null {
  if (!body) return null;
  let best: number | null = null;
  for (const re of [TIME_ATTR_RE, META_MODIFIED_RE, META_MODIFIED_ALT_RE]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const raw = m[1];
      if (!raw) continue;
      const t = Date.parse(raw);
      if (Number.isNaN(t)) continue;
      const year = new Date(t).getUTCFullYear();
      if (!Number.isInteger(year) || year < MIN_YEAR || year > maxYear) {
        continue;
      }
      if (best === null || year > best) best = year;
    }
  }
  return best;
}
