import type { PlaceCandidate } from "../models/types.js";
import { districtFromPlz } from "../lib/normalize.js";
import { makeLogger } from "../lib/logger.js";

const log = makeLogger("google-maps");

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";

// Vienna city-bounds rectangle (rough). Kept local; no need to build a polygon.
const VIENNA_BOUNDS = {
  low: { latitude: 48.116, longitude: 16.181 },
  high: { latitude: 48.323, longitude: 16.577 },
};

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.addressComponents",
  "places.location",
  "places.types",
  "places.primaryType",
  "places.websiteUri",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "nextPageToken",
].join(",");

interface RawPlace {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  addressComponents?: Array<{
    longText: string;
    shortText: string;
    types: string[];
  }>;
  location?: { latitude: number; longitude: number };
  types?: string[];
  primaryType?: string;
  websiteUri?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
}

interface SearchTextResponse {
  places?: RawPlace[];
  nextPageToken?: string;
}

export interface DiscoverOptions {
  query: string;
  maxResults?: number;
  plzFilter?: string | null;
}

export async function searchVienna(
  opts: DiscoverOptions,
): Promise<PlaceCandidate[]> {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) throw new Error("GOOGLE_MAPS_API_KEY not set");

  const maxResults = opts.maxResults ?? 20;
  const results: PlaceCandidate[] = [];
  let pageToken: string | undefined;
  let pageCount = 0;

  while (results.length < maxResults && pageCount < 5) {
    const body: Record<string, unknown> = {
      textQuery: opts.query,
      pageSize: Math.min(20, maxResults - results.length),
      locationBias: { rectangle: VIENNA_BOUNDS },
      languageCode: "de",
      regionCode: "AT",
    };
    if (pageToken) body.pageToken = pageToken;

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      log.error(`places:searchText ${res.status}`, text.slice(0, 300));
      break;
    }

    const data = (await res.json()) as SearchTextResponse;
    const batch = data.places ?? [];
    log.debug(`page ${pageCount} → ${batch.length} places (query: "${opts.query}")`);

    for (const p of batch) {
      const candidate = toCandidate(p);
      if (!candidate) continue;
      if (opts.plzFilter && candidate.plz !== opts.plzFilter) continue;
      results.push(candidate);
      if (results.length >= maxResults) break;
    }

    pageToken = data.nextPageToken;
    pageCount += 1;
    if (!pageToken) break;
    // Places API requires ~2s before consuming a pageToken
    await sleep(2100);
  }

  return dedupeByPlaceId(results);
}

function toCandidate(p: RawPlace): PlaceCandidate | null {
  if (!p.id || !p.displayName?.text) return null;
  const plz = extractPlz(p);
  return {
    placeId: p.id,
    name: p.displayName.text,
    address: p.formattedAddress ?? null,
    plz,
    district: districtFromPlz(plz),
    types: p.types ?? [],
    primaryType: p.primaryType ?? null,
    website: p.websiteUri ?? null,
    phone: p.internationalPhoneNumber ?? p.nationalPhoneNumber ?? null,
    lat: p.location?.latitude ?? 0,
    lng: p.location?.longitude ?? 0,
  };
}

function extractPlz(p: RawPlace): string | null {
  const comp = p.addressComponents?.find((c) => c.types.includes("postal_code"));
  if (comp?.longText && /^1\d{3}$/.test(comp.longText)) return comp.longText;
  // Fallback: regex on the formatted address
  const m = p.formattedAddress?.match(/\b(1\d{3})\b/);
  return m?.[1] ?? null;
}

function dedupeByPlaceId(list: PlaceCandidate[]): PlaceCandidate[] {
  const seen = new Set<string>();
  const out: PlaceCandidate[] = [];
  for (const c of list) {
    if (seen.has(c.placeId)) continue;
    seen.add(c.placeId);
    out.push(c);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
