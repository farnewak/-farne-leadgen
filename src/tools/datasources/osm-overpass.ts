import type { PlaceCandidate } from "../../models/types.js";
import { makeLogger } from "../../lib/logger.js";
import { OSM_TAG_TO_GPLACES_KEY } from "../../pipeline/classify-osm.js";
import type { DataSource, DataSourceSearchOptions } from "./types.js";
import {
  ageDays,
  hashQuery,
  isStale,
  readCache,
  readIndex,
  writeCache,
  writeIndex,
} from "./osm-overpass-cache.js";
import {
  elementToCandidate,
  type OverpassElement,
  type OverpassResponse,
} from "./osm-overpass-mapping.js";

const log = makeLogger("osm-overpass");

interface OsmConfig {
  endpoint: string;
  userAgent: string;
  maxRequestsPerRun: number;
  timeoutSeconds: number;
  cacheDir: string;
  cacheTtlDays: number;
  minDelayMs: number;
}

const DEFAULTS: OsmConfig = {
  endpoint: "https://overpass-api.de/api/interpreter",
  userAgent:
    "farne-leadgen/0.1 (+https://farne-solutions.com; contact@farne-solutions.com)",
  maxRequestsPerRun: 40,
  timeoutSeconds: 180,
  cacheDir: "./runs/overpass-cache",
  cacheTtlDays: 14,
  minDelayMs: 1500,
};

function parseIntEnv(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function loadConfig(): OsmConfig {
  const e = process.env;
  return {
    // OVERPASS_URL is the canonical override (used by CLI smoke tests);
    // OVERPASS_ENDPOINT is kept as a legacy alias.
    endpoint: e.OVERPASS_URL ?? e.OVERPASS_ENDPOINT ?? DEFAULTS.endpoint,
    userAgent: e.OVERPASS_USER_AGENT ?? DEFAULTS.userAgent,
    maxRequestsPerRun: parseIntEnv(
      e.OVERPASS_MAX_REQUESTS_PER_RUN,
      DEFAULTS.maxRequestsPerRun,
    ),
    timeoutSeconds: parseIntEnv(e.OVERPASS_TIMEOUT_SECONDS, DEFAULTS.timeoutSeconds),
    cacheDir: e.OVERPASS_CACHE_DIR ?? DEFAULTS.cacheDir,
    cacheTtlDays: parseIntEnv(e.OVERPASS_CACHE_TTL_DAYS, DEFAULTS.cacheTtlDays),
    minDelayMs: parseIntEnv(e.OVERPASS_MIN_DELAY_MS, DEFAULTS.minDelayMs),
  };
}

export function buildOverpassQuery(timeoutSeconds: number): string {
  const statements = Object.keys(OSM_TAG_TO_GPLACES_KEY)
    .map((kv) => {
      const [k, v] = kv.split("=");
      return `  nwr["${k}"="${v}"](area.wien);`;
    })
    .join("\n");
  return (
    `[out:json][timeout:${timeoutSeconds}];\n` +
    `area["name"="Wien"]["boundary"="administrative"]["admin_level"="4"]->.wien;\n` +
    `(\n${statements}\n);\n` +
    `out tags center;\n`
  );
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

let lastCallTs = 0;
let requestsThisRun = 0;
let hasDelivered = false;

export function resetOsmSessionState(): void {
  lastCallTs = 0;
  requestsThisRun = 0;
  hasDelivered = false;
}

async function respectRateLimit(minDelayMs: number): Promise<void> {
  const elapsed = Date.now() - lastCallTs;
  if (lastCallTs > 0 && elapsed < minDelayMs) await sleep(minDelayMs - elapsed);
  lastCallTs = Date.now();
}

async function overpassFetch(
  query: string,
  cfg: OsmConfig,
): Promise<OverpassResponse> {
  const backoffs = [5000, 15000, 45000] as const;
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    await respectRateLimit(cfg.minDelayMs);
    try {
      const res = await fetch(cfg.endpoint, {
        method: "POST",
        headers: {
          "User-Agent": cfg.userAgent,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: `data=${encodeURIComponent(query)}`,
      });
      if (res.status === 400) {
        const text = await res.text();
        throw new Error(`overpass 400: ${text.slice(0, 200)}`);
      }
      if (res.status === 429 || res.status === 503 || res.status === 504) {
        if (attempt === backoffs.length) {
          throw new Error(`overpass ${res.status} after ${attempt} retries`);
        }
        const wait = backoffs[attempt] ?? 45000;
        log.warn(`overpass ${res.status}, retry ${attempt + 1} in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`overpass HTTP ${res.status}`);
      return (await res.json()) as OverpassResponse;
    } catch (err) {
      lastErr = err as Error;
      if (attempt === backoffs.length) throw lastErr;
      const wait = backoffs[attempt] ?? 45000;
      log.warn(`overpass attempt ${attempt + 1} failed: ${lastErr.message}`);
      await sleep(wait);
    }
  }
  throw lastErr ?? new Error("overpass: unreachable");
}

async function fetchViaCache(
  query: string,
  cfg: OsmConfig,
): Promise<OverpassElement[]> {
  const hash = hashQuery(query);
  const index = await readIndex(cfg.cacheDir);
  const entry = index[hash];

  if (entry && !isStale(entry, cfg.cacheTtlDays)) {
    const cached = await readCache<{ elements: OverpassElement[] }>(cfg.cacheDir, hash);
    if (cached?.elements) {
      log.info(
        `cache hit (age ${ageDays(entry.createdAt)}d, ${entry.resultCount} elements)`,
      );
      return cached.elements;
    }
  }

  try {
    if (requestsThisRun >= cfg.maxRequestsPerRun) {
      throw new Error(`overpass request budget exceeded (${cfg.maxRequestsPerRun})`);
    }
    requestsThisRun += 1;
    const response = await overpassFetch(query, cfg);
    const elements = response.elements ?? [];
    index[hash] = { createdAt: Date.now(), query, resultCount: elements.length };
    await writeCache(cfg.cacheDir, hash, { elements });
    await writeIndex(cfg.cacheDir, index);
    log.info(`cache miss → fetched ${elements.length} elements`);
    return elements;
  } catch (err) {
    if (entry) {
      const cached = await readCache<{ elements: OverpassElement[] }>(cfg.cacheDir, hash);
      if (cached?.elements) {
        log.warn(
          `fetch failed, serving stale cache (age ${ageDays(entry.createdAt)}d): ${(err as Error).message}`,
        );
        return cached.elements;
      }
    }
    throw err;
  }
}

export const osmOverpassSource: DataSource = {
  id: "osm-overpass",
  label: "OpenStreetMap Overpass",
  isConfigured(): boolean {
    // Overpass is public — no secret required. The source is always
    // available; configuration is tuning, not gating.
    return true;
  },
  async search(_opts: DataSourceSearchOptions): Promise<PlaceCandidate[]> {
    if (hasDelivered) return [];
    const cfg = loadConfig();
    const query = buildOverpassQuery(cfg.timeoutSeconds);
    const elements = await fetchViaCache(query, cfg);
    const out: PlaceCandidate[] = [];
    for (const el of elements) {
      const c = elementToCandidate(el);
      if (c) out.push(c);
    }
    hasDelivered = true;
    log.info(`delivered ${out.length} Vienna candidates`);
    return out;
  },
};
