import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PlaceCandidate } from "../models/types.js";
import {
  findPlaceByQuery,
  type PlacesQueryMatch,
} from "../tools/datasources/google-places.js";
import { googleApiKey, loadEnv } from "../lib/env.js";
import { makeLogger } from "../lib/logger.js";

const log = makeLogger("enrich");

const DAY_MS = 24 * 60 * 60 * 1000;

// `drop` = the place is CLOSED_PERMANENTLY and MUST be removed from the run.
// `updated` = Places returned a match; the enrichment payload carries the
//             new fields (any of which may still be null). Caller decides how
//             to merge into the candidate.
// `no-match` = Places returned zero results; candidate stays as-is.
// `skipped-quota` = daily quota exhausted — no call made, candidate stays.
// `skipped-disabled` = feature flag off or no API key — no call made.
export type EnrichVerdict =
  | "drop"
  | "updated"
  | "no-match"
  | "skipped-quota"
  | "skipped-disabled";

export interface EnrichResult {
  verdict: EnrichVerdict;
  match: PlacesQueryMatch | null;
  cacheHit: boolean;
}

export interface EnrichOptions {
  // Injectable for tests so no real fetch() is required.
  findPlaceByQuery?: (query: string) => Promise<PlacesQueryMatch | null>;
  cacheDir?: string;
  cacheTtlDays?: number;
  dailyQuota?: number;
  now?: () => Date;
  // Disable feature flag check — tests that inject a fake findPlaceByQuery
  // typically do not need a real API key set in env.
  skipConfigCheck?: boolean;
}

interface CachedEntry {
  createdAt: number;
  query: string;
  match: PlacesQueryMatch | null;
}

interface QuotaState {
  date: string; // YYYY-MM-DD in UTC
  count: number;
}

// Public for integration tests that need to reset quota state between runs.
export function quotaFilePath(cacheDir: string): string {
  return join(cacheDir, "quota.json");
}

function cacheFilePath(cacheDir: string, hash: string): string {
  return join(cacheDir, `${hash}.json`);
}

function buildQuery(candidate: PlaceCandidate): string {
  // Spec §C I2: `${name} ${street} ${postcode} Wien Austria`.
  const parts = [candidate.name];
  if (candidate.address) parts.push(candidate.address);
  else if (candidate.plz) parts.push(candidate.plz);
  parts.push("Wien Austria");
  return parts.filter(Boolean).join(" ");
}

function cacheKey(candidate: PlaceCandidate): string {
  const basis = `${candidate.name}|${candidate.address ?? ""}`;
  return createHash("sha256").update(basis).digest("hex");
}

function ymdUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function readCache(
  cacheDir: string,
  hash: string,
): Promise<CachedEntry | null> {
  try {
    const raw = await readFile(cacheFilePath(cacheDir, hash), "utf8");
    return JSON.parse(raw) as CachedEntry;
  } catch {
    return null;
  }
}

async function writeCache(
  cacheDir: string,
  hash: string,
  entry: CachedEntry,
): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cacheFilePath(cacheDir, hash), JSON.stringify(entry), "utf8");
}

async function readQuota(cacheDir: string): Promise<QuotaState | null> {
  try {
    const raw = await readFile(quotaFilePath(cacheDir), "utf8");
    return JSON.parse(raw) as QuotaState;
  } catch {
    return null;
  }
}

async function writeQuota(cacheDir: string, state: QuotaState): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(
    quotaFilePath(cacheDir),
    JSON.stringify(state),
    "utf8",
  );
}

// Per-UTC-day counter persisted to a JSON file. A day-boundary transition
// zeros the counter on first read. Returns the NEW count after incrementing.
async function incrementQuota(
  cacheDir: string,
  now: Date,
): Promise<number> {
  const today = ymdUtc(now);
  const prev = await readQuota(cacheDir);
  const next: QuotaState =
    prev && prev.date === today
      ? { date: today, count: prev.count + 1 }
      : { date: today, count: 1 };
  await writeQuota(cacheDir, next);
  return next.count;
}

async function currentQuota(cacheDir: string, now: Date): Promise<number> {
  const prev = await readQuota(cacheDir);
  if (!prev || prev.date !== ymdUtc(now)) return 0;
  return prev.count;
}

// Merges a Places match into a candidate, respecting OSM-priority (I6):
// existing non-null fields on the candidate are preserved. Returns a NEW
// object; the input is not mutated.
export function mergeEnrichment(
  candidate: PlaceCandidate,
  match: PlacesQueryMatch,
): PlaceCandidate {
  return {
    ...candidate,
    website: candidate.website ?? match.websiteUri,
    phone: candidate.phone ?? match.phone,
    address: candidate.address ?? match.formattedAddress,
  };
}

// Central dispatch: cache lookup → quota check → API call → cache write.
// I7: CLOSED_PERMANENTLY → verdict=drop.
// I8/I9: anything else non-drop → candidate stays (additive, never reductive).
export async function enrichB3Candidate(
  candidate: PlaceCandidate,
  opts: EnrichOptions = {},
): Promise<EnrichResult> {
  const env = loadEnv();
  const cacheDir = opts.cacheDir ?? env.PLACES_CACHE_DIR;
  const cacheTtlDays = opts.cacheTtlDays ?? env.PLACES_CACHE_TTL_DAYS;
  const dailyQuota = opts.dailyQuota ?? env.GOOGLE_PLACES_DAILY_QUOTA;
  const nowFn = opts.now ?? (() => new Date());
  const now = nowFn();
  const hash = cacheKey(candidate);
  const query = buildQuery(candidate);

  // I5: Cache lookup first — a hit avoids both quota consumption and network.
  const cached = await readCache(cacheDir, hash);
  if (cached && now.getTime() - cached.createdAt < cacheTtlDays * DAY_MS) {
    log.debug(`cache hit for ${candidate.placeId}`);
    return verdictForMatch(cached.match, true);
  }

  // Skip gating: feature flag + key presence (unless caller injects a stub).
  const injected = opts.findPlaceByQuery;
  if (!injected && !opts.skipConfigCheck) {
    if (!env.B3_ENRICHMENT_ENABLED) {
      return { verdict: "skipped-disabled", match: null, cacheHit: false };
    }
    if (!googleApiKey()) {
      return { verdict: "skipped-disabled", match: null, cacheHit: false };
    }
  }

  // I4: budget guard — refuse new API calls once daily quota is reached.
  const used = await currentQuota(cacheDir, now);
  if (used >= dailyQuota) {
    log.warn(
      `daily quota reached (${used}/${dailyQuota}) — skipping ${candidate.placeId}`,
    );
    return { verdict: "skipped-quota", match: null, cacheHit: false };
  }

  const doFind = injected ?? findPlaceByQuery;
  let match: PlacesQueryMatch | null = null;
  try {
    match = await doFind(query);
    await incrementQuota(cacheDir, now);
  } catch (err) {
    log.warn(
      `enrich failed for ${candidate.placeId}: ${(err as Error).message}`,
    );
    // Cache a negative result on transient failure? No — we treat it as
    // a non-call so a later retry can succeed. No quota consumed.
    return { verdict: "no-match", match: null, cacheHit: false };
  }

  // Persist cache entry (including null-match, so repeated runs don't
  // re-query a candidate that Places never found).
  await writeCache(cacheDir, hash, {
    createdAt: now.getTime(),
    query,
    match,
  });

  return verdictForMatch(match, false);
}

function verdictForMatch(
  match: PlacesQueryMatch | null,
  cacheHit: boolean,
): EnrichResult {
  if (!match) return { verdict: "no-match", match: null, cacheHit };
  if (match.businessStatus === "CLOSED_PERMANENTLY") {
    return { verdict: "drop", match, cacheHit };
  }
  return { verdict: "updated", match, cacheHit };
}
