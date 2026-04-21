// FIX 10 — cascaded CMS detector. Each step is independently fail-safe; the
// first step to return a non-null slug wins. The caller (audit pipeline)
// only sees a single canonical slug from the set defined in
// CANONICAL_CMS_SLUGS below, plus the two sentinel values:
//   "static_or_custom" — body was non-empty, no fingerprint matched.
//   "unknown"          — audit never reached the CMS step (no body).
//
// Step A reuses the existing high-confidence fingerprint detector
// (src/pipeline/tech-fingerprints.ts, MIN_MATCHES=2). Steps B–D are
// single-signal fallbacks: they fire on weaker evidence and are therefore
// only consulted when Step A could not pin a CMS. Any exception inside a
// step is swallowed and treated as "no match" so a malformed meta tag or
// regex explosion in one step can never poison the rest.

import { makeLogger } from "../lib/logger.js";

const log = makeLogger("cms-detect");

export const CANONICAL_CMS_SLUGS = [
  "wordpress",
  "drupal",
  "joomla",
  "typo3",
  "wix",
  "squarespace",
  "shopify",
  "webflow",
  "nextjs",
  "nuxt",
  "gatsby",
  "ghost",
  "jimdo",
  "weebly",
  "contao",
  "hubspot",
  "kirby",
  "craft",
] as const;

export type CmsSlug =
  | (typeof CANONICAL_CMS_SLUGS)[number]
  | "static_or_custom"
  | "unknown";

const SLUG_SET = new Set<string>(CANONICAL_CMS_SLUGS);

// Meta-generator tokens → canonical slugs. The token is the first whitespace-
// delimited word of the <meta name="generator" content="…"> attribute,
// lowercased. Multiple raw spellings collapse to one slug.
const GENERATOR_TOKEN_MAP: Record<string, (typeof CANONICAL_CMS_SLUGS)[number]> = {
  wordpress: "wordpress",
  drupal: "drupal",
  joomla: "joomla",
  "joomla!": "joomla",
  typo3: "typo3",
  wix: "wix",
  "wix.com": "wix",
  squarespace: "squarespace",
  shopify: "shopify",
  webflow: "webflow",
  "next.js": "nextjs",
  nextjs: "nextjs",
  nuxt: "nuxt",
  "nuxt.js": "nuxt",
  gatsby: "gatsby",
  gatsbyjs: "gatsby",
  ghost: "ghost",
  jimdo: "jimdo",
  weebly: "weebly",
  contao: "contao",
  hubspot: "hubspot",
  kirby: "kirby",
  craft: "craft",
  craftcms: "craft",
};

export interface CmsDetectInput {
  body: string;
  headers: Record<string, string>;
  // Optional: the output of detectTechStack(body, headers).signals.cms. When
  // present and non-empty, Step A treats the first entry as the fast-path
  // winner (existing MIN_MATCHES=2 fingerprint matched).
  existingCms?: string[];
}

export interface CmsDetectResult {
  cms: CmsSlug;
}

// Top-level. Runs Steps A→E; every step is wrapped so a thrown error in one
// step can never cascade. On total failure (body parsing threw, headers
// malformed) the result collapses to the safe "unknown" sentinel.
export function detectCms(input: CmsDetectInput): CmsDetectResult {
  try {
    const stepA = detectFromExistingFingerprint(input.existingCms);
    if (stepA) return { cms: stepA };

    const stepB = safeStep("meta-generator", () =>
      detectMetaGenerator(input.body),
    );
    if (stepB) return { cms: stepB };

    const stepC = safeStep("header-signature", () =>
      detectHeaderSignature(input.headers),
    );
    if (stepC) return { cms: stepC };

    const stepD = safeStep("asset-path", () => detectAssetPaths(input.body));
    if (stepD) return { cms: stepD };

    // Step E: reached CMS step with body → static_or_custom. No body → unknown.
    // The distinction is semantically important: "unknown" means "we never
    // looked" (fetch error upstream); "static_or_custom" means "we looked
    // and found no fingerprint". Downstream filters can act differently on
    // each (e.g., outreach skips static_or_custom in favour of known CMS).
    if (input.body && input.body.length > 0) {
      return { cms: "static_or_custom" };
    }
    return { cms: "unknown" };
  } catch (err) {
    log.warn(`detectCms failed: ${(err as Error).message}`);
    return { cms: "unknown" };
  }
}

function safeStep(
  name: string,
  fn: () => (typeof CANONICAL_CMS_SLUGS)[number] | null,
): (typeof CANONICAL_CMS_SLUGS)[number] | null {
  try {
    return fn();
  } catch (err) {
    log.warn(`cms-detect step ${name} failed: ${(err as Error).message}`);
    return null;
  }
}

// Step A. The existing fingerprint detector already emits canonical slug IDs
// (wordpress, wix, squarespace, jimdo, …). We only accept a value if it is
// inside our canonical set; unknown IDs (e.g. "prestashop", "magento") are
// ignored so downstream filters don't see surprises.
function detectFromExistingFingerprint(
  existing: string[] | undefined,
): (typeof CANONICAL_CMS_SLUGS)[number] | null {
  if (!existing || existing.length === 0) return null;
  for (const id of existing) {
    const lower = id.toLowerCase();
    if (SLUG_SET.has(lower)) {
      return lower as (typeof CANONICAL_CMS_SLUGS)[number];
    }
  }
  return null;
}

// Step B. <meta name="generator" content="…">. Takes the first whitespace-
// delimited token, lowercases it, looks it up in the generator token map.
// Quotes around the attribute value may be single or double. HTML is case-
// insensitive on attribute names. We scan the first 256KB only (same budget
// as detectTechStack) to bound regex work on adversarial input.
const META_SCAN_BYTES = 256 * 1024;
const META_GEN_RE =
  /<meta\s+[^>]*name\s*=\s*["']generator["'][^>]*content\s*=\s*["']([^"']*)["']/i;
const META_GEN_RE_ALT =
  /<meta\s+[^>]*content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']generator["']/i;

function detectMetaGenerator(
  body: string,
): (typeof CANONICAL_CMS_SLUGS)[number] | null {
  if (!body) return null;
  const scan = body.length > META_SCAN_BYTES ? body.slice(0, META_SCAN_BYTES) : body;
  const m = scan.match(META_GEN_RE) ?? scan.match(META_GEN_RE_ALT);
  if (!m) return null;
  const content = m[1]?.trim() ?? "";
  if (!content) return null;
  const firstToken = content.split(/\s+/)[0]?.toLowerCase() ?? "";
  return GENERATOR_TOKEN_MAP[firstToken] ?? null;
}

// Step C. Response headers. The header names here are all lowercase because
// we receive a lowercased header map from the HTTP layer, but we also defend
// against mixed-case input by lowercasing locally. "PHP/x.y" on x-powered-by
// is explicitly NOT a CMS signal — too many shared-hosting stacks set it.
function detectHeaderSignature(
  headers: Record<string, string>,
): (typeof CANONICAL_CMS_SLUGS)[number] | null {
  if (!headers) return null;
  const lc: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    lc[k.toLowerCase()] = String(v ?? "");
  }
  if (lc["x-drupal-cache"] !== undefined && lc["x-drupal-cache"] !== "") {
    return "drupal";
  }
  if (
    lc["x-typo3-parsedbody"] !== undefined &&
    lc["x-typo3-parsedbody"] !== ""
  ) {
    return "typo3";
  }
  if (
    lc["x-shopify-stage"] !== undefined &&
    lc["x-shopify-stage"] !== ""
  ) {
    return "shopify";
  }
  const xpb = lc["x-powered-by"] ?? lc["x-generator"];
  if (!xpb) return null;
  const firstToken = xpb.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (!firstToken) return null;
  // "PHP/7.4" or "PHP" alone: too weak, ignore.
  if (firstToken === "php" || firstToken.startsWith("php/")) return null;
  return GENERATOR_TOKEN_MAP[firstToken] ?? null;
}

// Step D. Asset-path fingerprints. Cheap substring scan over the body. Each
// needle is unambiguous enough that a single occurrence is a strong signal.
interface AssetNeedle {
  readonly slug: (typeof CANONICAL_CMS_SLUGS)[number];
  readonly needles: readonly string[];
}

const ASSET_NEEDLES: readonly AssetNeedle[] = [
  { slug: "wordpress", needles: ["/wp-content/"] },
  { slug: "drupal", needles: ["/sites/default/"] },
  { slug: "typo3", needles: ["/typo3conf/"] },
  { slug: "nextjs", needles: ["/_next/"] },
  { slug: "nuxt", needles: ["/_nuxt/"] },
  { slug: "joomla", needles: ["/joomla", "/media/jui/"] },
  { slug: "shopify", needles: ["cdn.shopify.com", "shopify.com/s/files"] },
  {
    slug: "squarespace",
    needles: ["squarespace-cdn", "static1.squarespace.com"],
  },
  { slug: "wix", needles: ["wixstatic.com"] },
  { slug: "webflow", needles: ["webflow.com", "assets.website-files.com"] },
  { slug: "jimdo", needles: ["jimdo.com", "jimdofree.com"] },
  { slug: "weebly", needles: ["weebly.com"] },
];

function detectAssetPaths(
  body: string,
): (typeof CANONICAL_CMS_SLUGS)[number] | null {
  if (!body) return null;
  const scan = body.length > META_SCAN_BYTES ? body.slice(0, META_SCAN_BYTES) : body;
  for (const entry of ASSET_NEEDLES) {
    for (const needle of entry.needles) {
      if (scan.includes(needle)) return entry.slug;
    }
  }
  return null;
}
