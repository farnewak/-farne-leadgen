import { load } from "cheerio";
import type { PlaceCandidate } from "../models/types.js";
import { loadEnv } from "../lib/env.js";
import { fetchUrl } from "../lib/http-fetch.js";
import { makeLogger } from "../lib/logger.js";
import { pickExtractor, normalizeUrl } from "./directory-extractors/index.js";
import { validatesCandidate } from "./dns-probe.js";

const log = makeLogger("cse-discovery");
const CSE_ENDPOINT = "https://www.googleapis.com/customsearch/v1";

// Soft daily counter. Google CSE free tier is 100 queries/day; we log at that
// threshold but don't block — hard-blocking would require DB persistence and
// cross-run tracking, which isn't worth it for a best-effort discovery layer.
let queriesToday = 0;
let quotaReached = false;

export function resetCseState(): void {
  queriesToday = 0;
  quotaReached = false;
}

export interface CseDiscoveryResult {
  discoveredUrl: string;
  via: string;
  method: "cse";
}

interface CseResponse {
  items?: Array<{ link?: string }>;
}

function buildQueries(c: PlaceCandidate): string[] {
  const out: string[] = [];
  const locationHint = c.plz ? `"${c.plz} Wien"` : '"Wien"';
  out.push(`"${c.name}" ${locationHint}`);
  if (c.phone) out.push(`"${c.name}" "${c.phone}"`);
  const districtHint = c.district ? `"Bezirk ${c.district}"` : '"Wien"';
  out.push(`"${c.name}" ${districtHint}`);
  return out.slice(0, 3);
}

async function callCse(
  query: string,
  apiKey: string,
  cx: string,
): Promise<{ links: string[]; rateLimited: boolean }> {
  const url =
    `${CSE_ENDPOINT}?key=${encodeURIComponent(apiKey)}` +
    `&cx=${encodeURIComponent(cx)}&q=${encodeURIComponent(query)}&num=10`;
  const res = await fetchUrl(url, { retries: 0, timeoutMs: 10_000 });
  if (res.status === 429) return { links: [], rateLimited: true };
  if (res.error || res.status !== 200) return { links: [], rateLimited: false };
  try {
    const data = JSON.parse(res.body) as CseResponse;
    const links = (data.items ?? [])
      .map((i) => i.link)
      .filter((l): l is string => typeof l === "string");
    return { links, rateLimited: false };
  } catch {
    return { links: [], rateLimited: false };
  }
}

async function tryExtractFrom(
  link: string,
  candidate: PlaceCandidate,
): Promise<CseDiscoveryResult | null> {
  const extractor = pickExtractor(link);
  if (!extractor) return null;
  const res = await fetchUrl(link);
  if (res.error || res.status >= 400) return null;
  const extracted = extractor.extract(res.body, load(res.body));
  const normalized = normalizeUrl(extracted ?? undefined);
  if (!normalized) return null;
  const verifyRes = await fetchUrl(normalized);
  if (verifyRes.error || verifyRes.status >= 400) return null;
  if (!validatesCandidate(verifyRes.body, candidate)) return null;
  return { discoveredUrl: normalized, via: extractor.id, method: "cse" };
}

export async function discoverViaCse(
  candidate: PlaceCandidate,
): Promise<CseDiscoveryResult | null> {
  const env = loadEnv();
  if (!env.CSE_DISCOVERY_ENABLED) return null;
  if (!env.GOOGLE_API_KEY || !env.GOOGLE_CSE_ID) {
    log.warn("CSE enabled but GOOGLE_API_KEY or GOOGLE_CSE_ID missing");
    return null;
  }
  if (quotaReached) return null;

  const queries = buildQueries(candidate).slice(
    0,
    env.CSE_MAX_QUERIES_PER_CANDIDATE,
  );
  for (const q of queries) {
    queriesToday += 1;
    if (queriesToday === 100) log.warn("CSE: 100 queries hit (daily quota)");
    const { links, rateLimited } = await callCse(
      q,
      env.GOOGLE_API_KEY,
      env.GOOGLE_CSE_ID,
    );
    if (rateLimited) {
      log.warn(`CSE 429 for "${q}" — skipping candidate`);
      quotaReached = true;
      return null;
    }
    for (const link of links) {
      const hit = await tryExtractFrom(link, candidate);
      if (hit) return hit;
    }
  }
  return null;
}
