import type { PlaceCandidate } from "../models/types.js";
import { fetchUrl } from "../lib/http-fetch.js";
import { validatesCandidate } from "./dns-probe.js";

// Per-run in-memory cache. Same URL from two candidates skips the second
// fetch — discovery batches often hit the same directory page or shared
// homepage. Cache key = url + candidate name to avoid cross-contamination
// (URL may validate for one business but not another).
const cache = new Map<string, boolean>();

export function resetCandidateValidatorCache(): void {
  cache.clear();
}

function cacheKey(url: string, candidate: PlaceCandidate): string {
  return `${url}::${candidate.placeId}`;
}

export async function validateDiscoveredUrl(
  url: string,
  candidate: PlaceCandidate,
): Promise<boolean> {
  const key = cacheKey(url, candidate);
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const res = await fetchUrl(url);
  if (res.error || res.status >= 400) {
    cache.set(key, false);
    return false;
  }
  const ok = validatesCandidate(res.body, candidate);
  cache.set(key, ok);
  return ok;
}
