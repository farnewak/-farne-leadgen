import { makeLogger } from "../../lib/logger.js";
import type { DataSource } from "./types.js";
import { googlePlacesSource } from "./google-places.js";
import { osmOverpassSource } from "./osm-overpass.js";

const log = makeLogger("registry");

// Central list of all known sources. New sources (WKO, …) get registered
// here once implemented.
const ALL_SOURCES: readonly DataSource[] = [googlePlacesSource, osmOverpassSource];

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
