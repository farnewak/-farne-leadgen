import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlaceCandidate } from "../../models/types.js";
import { slugify } from "../../lib/normalize.js";
import { makeLogger } from "../../lib/logger.js";

// Chain filter drops B2C mass-market franchise branches (supermarkets,
// drugstores, fast-food, fuel, mobile-phone, bank). Premium single-owner
// businesses (jewelers, lawyers, galleries) are explicitly whitelisted
// — even when they carry internationally known names like Wempe or
// Bucherer. The whitelist/blacklist payloads live as JSON so new entries
// do not require code changes.
//
// Interface with PlaceCandidate: the OSM mapping packs the raw tag into
// `types` as "{key}={value}" and optionally appends "brand:<value>".
// Google Places candidates lack the key=value format, so the filter's
// category extraction returns null for them and they are kept by default.

export interface ChainFilterDecision {
  kept: boolean;
  reason: string;
}

interface ChainEntry {
  id: string;
  tokens: string[];
  categories: string[];
}

interface Blacklist {
  chains: ChainEntry[];
}

interface Whitelist {
  shop: string[];
  office: string[];
  amenity: string[];
}

const log = makeLogger("chain-filter");

const HERE = dirname(fileURLToPath(import.meta.url));
const BLACKLIST_PATH = resolve(
  HERE,
  "../../../data/chain-blacklist-wien.json",
);
const WHITELIST_PATH = resolve(
  HERE,
  "../../../data/premium-whitelist.json",
);

let blacklistCache: Blacklist | null = null;
let whitelistCache: Whitelist | null = null;

function loadBlacklist(): Blacklist {
  if (!blacklistCache) {
    const raw = readFileSync(BLACKLIST_PATH, "utf-8");
    blacklistCache = JSON.parse(raw) as Blacklist;
  }
  return blacklistCache;
}

function loadWhitelist(): Whitelist {
  if (!whitelistCache) {
    const raw = readFileSync(WHITELIST_PATH, "utf-8");
    whitelistCache = JSON.parse(raw) as Whitelist;
  }
  return whitelistCache;
}

// Test hook: discard cached JSON so a fresh file read happens on the
// next invocation. Not used in production code.
export function resetChainFilterCache(): void {
  blacklistCache = null;
  whitelistCache = null;
}

const OSM_TAG_KEYS = new Set([
  "shop",
  "office",
  "amenity",
  "craft",
  "healthcare",
  "leisure",
]);

function extractOsmTag(
  types: readonly string[],
): { key: string; value: string } | null {
  for (const t of types) {
    const eq = t.indexOf("=");
    if (eq <= 0) continue;
    const key = t.slice(0, eq);
    const value = t.slice(eq + 1);
    if (!value) continue;
    if (OSM_TAG_KEYS.has(key)) return { key, value };
  }
  return null;
}

function hasBrandSignal(types: readonly string[]): boolean {
  return types.some((t) => t.startsWith("brand:") && t.length > "brand:".length);
}

function nameTokens(name: string): Set<string> {
  const slug = slugify(name);
  const out = new Set<string>();
  for (const part of slug.split("-")) {
    if (part.length > 0) out.add(part);
  }
  return out;
}

function whitelistHit(
  osm: { key: string; value: string },
  white: Whitelist,
): string | null {
  if (osm.key === "shop" && white.shop.includes(osm.value)) {
    return `whitelist:shop:${osm.value}`;
  }
  if (osm.key === "office" && white.office.includes(osm.value)) {
    return `whitelist:office:${osm.value}`;
  }
  if (osm.key === "amenity" && white.amenity.includes(osm.value)) {
    return `whitelist:amenity:${osm.value}`;
  }
  return null;
}

export function classifyChainCandidate(
  candidate: PlaceCandidate,
): ChainFilterDecision {
  const osm = extractOsmTag(candidate.types);

  if (osm) {
    const hit = whitelistHit(osm, loadWhitelist());
    if (hit) return { kept: true, reason: hit };
  }

  if (!osm) return { kept: true, reason: "keep:no-match" };

  const category = `${osm.key}=${osm.value}`;
  const tokens = nameTokens(candidate.name);

  for (const entry of loadBlacklist().chains) {
    if (!entry.categories.includes(category)) continue;
    const allPresent = entry.tokens.every((t) => tokens.has(t));
    if (!allPresent) continue;
    if (!hasBrandSignal(candidate.types)) continue;
    return { kept: false, reason: `blacklist:${category}:${entry.id}` };
  }

  return { kept: true, reason: "keep:no-match" };
}

export function filterChains<T extends PlaceCandidate>(
  candidates: readonly T[],
): T[] {
  const out: T[] = [];
  let dropped = 0;
  for (const c of candidates) {
    const decision = classifyChainCandidate(c);
    log.debug(`filter decision for ${c.placeId}`, {
      placeId: c.placeId,
      name: c.name,
      kept: decision.kept,
      reason: decision.reason,
    });
    if (decision.kept) {
      out.push(c);
      continue;
    }
    dropped += 1;
    log.info(`dropped ${c.name}`, {
      placeId: c.placeId,
      name: c.name,
      kept: decision.kept,
      reason: decision.reason,
    });
  }
  if (dropped > 0) {
    log.info(`chain filter dropped ${dropped}/${candidates.length}`);
  }
  return out;
}
