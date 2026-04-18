import { load, type CheerioAPI } from "cheerio";

export interface SchemaOrgResult {
  hasSchemaOrg: boolean;
  types: string[];
}

// Types we care about for SME classification. Anything else gets collapsed
// into the generic "hasSchemaOrg=true" flag — the score model only needs to
// know "did they bother with structured data", not every @type they used.
const INTERESTING_TYPES = new Set<string>([
  "Organization",
  "LocalBusiness",
  "Restaurant",
  "Store",
  "Service",
  "Product",
  "WebSite",
  "BreadcrumbList",
  "Person",
  "Article",
  "BlogPosting",
  "Event",
  "FAQPage",
]);

function normalizeType(raw: string): string {
  // "https://schema.org/Organization" or "schema:Organization" → "Organization".
  const tail = raw.split(/[#/:]/).pop();
  return (tail ?? raw).trim();
}

function collectJsonLdTypes($: CheerioAPI): string[] {
  const found = new Set<string>();
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Malformed JSON-LD is common in the wild (trailing commas, jsonp-style
      // callbacks). Ignore — we still have microdata as fallback.
      return;
    }
    walkForTypes(parsed, found);
  });
  return [...found];
}

function walkForTypes(node: unknown, out: Set<string>): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) walkForTypes(item, out);
    return;
  }
  if (typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  const t = obj["@type"];
  if (typeof t === "string") {
    out.add(normalizeType(t));
  } else if (Array.isArray(t)) {
    for (const candidate of t) {
      if (typeof candidate === "string") out.add(normalizeType(candidate));
    }
  }
  // Recurse into @graph and nested objects — JSON-LD allows arbitrary nesting.
  for (const value of Object.values(obj)) {
    if (value && typeof value === "object") walkForTypes(value, out);
  }
}

function collectMicrodataTypes($: CheerioAPI): string[] {
  const found = new Set<string>();
  $("[itemtype]").each((_, el) => {
    const raw = $(el).attr("itemtype") ?? "";
    for (const part of raw.split(/\s+/)) {
      if (!part) continue;
      if (/schema\.org/i.test(part)) {
        found.add(normalizeType(part));
      }
    }
  });
  return [...found];
}

// Two-stage check: (1) JSON-LD is the modern/dominant form; (2) microdata
// fallback for older Joomla/Typo3 templates. Types outside INTERESTING_TYPES
// still flip hasSchemaOrg=true, they just do not appear in `types`.
export function detectSchemaOrg(html: string): SchemaOrgResult {
  if (!html) return { hasSchemaOrg: false, types: [] };
  const $ = load(html);
  return detectSchemaOrgFromCheerio($);
}

export function detectSchemaOrgFromCheerio(
  $: CheerioAPI,
): SchemaOrgResult {
  const jsonLd = collectJsonLdTypes($);
  const microdata = collectMicrodataTypes($);
  const all = new Set<string>([...jsonLd, ...microdata]);

  if (all.size === 0) {
    return { hasSchemaOrg: false, types: [] };
  }

  const interesting: string[] = [];
  for (const t of all) {
    if (INTERESTING_TYPES.has(t)) interesting.push(t);
  }
  // Stable, deduped, sorted — tests want predictable ordering.
  return {
    hasSchemaOrg: true,
    types: interesting.sort(),
  };
}
