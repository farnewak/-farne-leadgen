import { makeLogger } from "../../lib/logger.js";
import type { DataSource } from "./types.js";
import { googlePlacesSource } from "./google-places.js";
import { osmOverpassSource } from "./osm-overpass.js";

const log = makeLogger("registry");

// Central list of all known sources, ordered by priority for the
// per-seed fallback in src/pipeline/discover.ts. OSM is free + covers
// all Vienna in one dump, so it runs first; Google Places fills in when
// OSM is down or rate-limited (CLAUDE.md: "OSM/WKO sind Default").
// New sources (WKO, …) get registered here once implemented.
export const ALL_SOURCES: readonly DataSource[] = [
  osmOverpassSource,
  googlePlacesSource,
];

// Pure filter — exposed for tests so no process.env manipulation is needed.
// Logs per-source status and throws if nothing is active.
export function selectActive(sources: readonly DataSource[]): DataSource[] {
  const active: DataSource[] = [];
  for (const src of sources) {
    if (src.isConfigured()) {
      log.info(`active: ${src.id} (${src.label})`);
      active.push(src);
    } else {
      log.warn(`skipped: ${src.id} — not configured (missing env/credentials)`);
    }
  }

  if (active.length === 0) {
    throw new Error(
      "No DataSource configured. Set GOOGLE_MAPS_API_KEY or enable another source (OSM Overpass, WKO).",
    );
  }

  return active;
}

export function getActiveSources(): DataSource[] {
  return selectActive(ALL_SOURCES);
}
