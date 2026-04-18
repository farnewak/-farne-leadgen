import type { CheerioAPI } from "cheerio";

export interface DirectoryExtractor {
  id: string;
  hostPattern: RegExp;
  // Returns the extracted public website URL, or null if none found or if the
  // candidate fails the shared-blacklist check (directory-to-directory link).
  extract(html: string, $: CheerioAPI): string | null;
}

// Hosts that are themselves directories, social networks, or map services —
// never count as a "discovered public website" for scoring purposes. Each
// extractor filters its own output through this list so the caller never
// has to re-check.
const BLACKLIST_HOSTS = [
  "facebook.com",
  "instagram.com",
  "herold.at",
  "firmenabc.at",
  "firmen.wko.at",
  "wko.at",
  "falstaff.at",
  "gaultmillau.at",
  "linkedin.com",
  "xing.com",
  "maps.google.com",
  "google.com",
  "yelp.com",
  "tripadvisor.com",
  "tripadvisor.at",
] as const;

export function isBlacklistedHost(urlStr: string): boolean {
  try {
    const host = new URL(urlStr).hostname.toLowerCase().replace(/^www\./, "");
    return BLACKLIST_HOSTS.some((b) => host === b || host.endsWith(`.${b}`));
  } catch {
    return true; // malformed URL → treat as unusable
  }
}

// Strip common tracking/UTM params so downstream dedupe is not fooled.
// Kept tiny on purpose — a query-param allowlist would be over-engineered
// for this layer; we only need the final URL host+path for classification.
export function normalizeUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const u = new URL(trimmed);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const drop = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
    ];
    for (const k of drop) u.searchParams.delete(k);
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

// Shared convenience: pick first non-null normalized URL from a candidate
// list, dropping anything blacklisted. Each extractor is a thin wrapper
// around selector logic → this helper.
export function firstPublicUrl(
  candidates: Array<string | null | undefined>,
): string | null {
  for (const c of candidates) {
    const norm = normalizeUrl(c ?? undefined);
    if (!norm) continue;
    if (isBlacklistedHost(norm)) continue;
    return norm;
  }
  return null;
}
