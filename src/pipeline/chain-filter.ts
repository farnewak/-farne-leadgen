import { readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import { domainToASCII } from "node:url";
import YAML from "yaml";

// FIX 5 — chain-branch filter. Pipeline-stage counterpart to the candidate-
// stage `src/tools/filters/chain-filter.ts` (#24). This one operates on the
// DISCOVERED URL of a fully-audited row and drops obvious B2C chain branch
// pages (e.g. `spar.at/standorte/...`) that would otherwise pollute the
// Tier-A outreach list. Matches are appended to
// logs/filtered_chain_branches.csv and NOT persisted in the audit DB.
//
// Pattern semantics: a single `*` is greedy and matches 1+ characters
// (including `/`). Host part is normalised (lowercased, leading `www.`
// stripped, IDN → punycode via node:url#domainToASCII). `spar.at/` homepage
// never matches `spar.at/standorte/*` because `*` requires at least one
// character.

export interface ChainBranchPatternRaw {
  pattern: string;
  chain_name: string;
  reason: string;
}

export interface ChainBranchPattern {
  pattern: string;
  chain_name: string;
  reason: string;
  // Punycode-normalised `host<path>` form of the original pattern.
  normalizedPattern: string;
  // Precompiled regex — anchored, `*` → `.+` (greedy, at least 1 char).
  regex: RegExp;
}

export interface ChainBranchMatch {
  chain_name: string;
  reason: string;
  matched_pattern: string;
}

export interface FilteredChainBranchLogEntry {
  place_id: string;
  chain_name: string;
  url: string;
  matched_pattern: string;
  reason: string;
  filtered_at: Date;
}

const CSV_HEADER =
  "place_id,chain_name,url,matched_pattern,reason,filtered_at";

// Split a pattern like "spar.at/standorte/*" into host + path parts, then
// normalise the host to punycode so IDN entries (`ströck.at/*`) match the
// URL shape the `URL` parser produces (`xn--strck-3ya.at`). Everything is
// lowercased; `www.` prefixes on patterns are stripped too so users who
// typed them by accident still get a working entry.
function normalizePattern(raw: string): { normalized: string; regex: RegExp } {
  const firstSlash = raw.indexOf("/");
  const host = firstSlash === -1 ? raw : raw.slice(0, firstSlash);
  const path = firstSlash === -1 ? "" : raw.slice(firstSlash);
  const hostLower = host.toLowerCase().replace(/^www\./, "");
  const hostAscii = domainToASCII(hostLower) || hostLower;
  const normalized = hostAscii + path;
  // Escape regex special chars except `*`, then replace `*` with `.+`.
  const escaped = normalized
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".+");
  return { normalized, regex: new RegExp(`^${escaped}$`) };
}

export function loadChainBranchPatterns(path: string): ChainBranchPattern[] {
  const raw = readFileSync(path, "utf-8");
  const parsed = YAML.parse(raw) as ChainBranchPatternRaw[] | null;
  if (!Array.isArray(parsed)) {
    throw new Error(
      `chain_branches.yml at ${path} must parse to a YAML list, got ${typeof parsed}`,
    );
  }
  return parsed.map((entry) => {
    if (!entry.pattern || !entry.chain_name || !entry.reason) {
      throw new Error(
        `chain_branches.yml entry missing required fields: ${JSON.stringify(entry)}`,
      );
    }
    const { normalized, regex } = normalizePattern(entry.pattern);
    return {
      pattern: entry.pattern,
      chain_name: entry.chain_name,
      reason: entry.reason,
      normalizedPattern: normalized,
      regex,
    };
  });
}

// Normalise an input URL to the `host<path>` form used for pattern matching.
// `URL` already punycodes the hostname, so we just lowercase + drop `www.`.
function normalizeUrl(input: string): string | null {
  try {
    const u = new URL(input);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return host + u.pathname;
  } catch {
    return null;
  }
}

export function matchesChainBranch(
  url: string,
  patterns: ChainBranchPattern[],
): ChainBranchMatch | null {
  const normalized = normalizeUrl(url);
  if (normalized === null) return null;
  for (const p of patterns) {
    if (p.regex.test(normalized)) {
      return {
        chain_name: p.chain_name,
        reason: p.reason,
        matched_pattern: p.pattern,
      };
    }
  }
  return null;
}

// RFC 4180-lite CSV escaping: comma/quote/newline triggers quoting; embedded
// quotes are doubled. Dates emit as ISO-8601 (UTC).
function csvEscape(v: string): string {
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function rowToCsvLine(entry: FilteredChainBranchLogEntry): string {
  return [
    entry.place_id,
    entry.chain_name,
    entry.url,
    entry.matched_pattern,
    entry.reason,
    entry.filtered_at.toISOString(),
  ]
    .map(csvEscape)
    .join(",");
}

// Appends a single entry to the filtered-chain-branches CSV. Creates the
// file (with header) on first write. Callers pass the FULL file path so
// tests can redirect to tmp without monkey-patching fs.
export function appendFilteredChainBranchLog(
  entry: FilteredChainBranchLogEntry,
  csvPath: string,
): void {
  const dir = dirname(csvPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const needsHeader = !existsSync(csvPath);
  const body = needsHeader
    ? `${CSV_HEADER}\n${rowToCsvLine(entry)}\n`
    : `${rowToCsvLine(entry)}\n`;
  appendFileSync(csvPath, body, "utf-8");
}

export const FILTERED_CHAIN_BRANCHES_CSV_HEADER = CSV_HEADER;
