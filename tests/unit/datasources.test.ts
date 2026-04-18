import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PlaceCandidate } from "../../src/models/types.js";
import type { DataSource, DataSourceSearchOptions } from "../../src/tools/datasources/types.js";
import { selectActive, ALL_SOURCES } from "../../src/tools/datasources/registry.js";
import { googlePlacesSource } from "../../src/tools/datasources/google-places.js";
import { resetEnvCache } from "../../src/lib/env.js";

function makeMockSource(overrides: Partial<DataSource> = {}): DataSource {
  return {
    id: "mock",
    label: "Mock Source",
    isConfigured: () => true,
    search: async (_opts: DataSourceSearchOptions): Promise<PlaceCandidate[]> => [],
    ...overrides,
  };
}

describe("googlePlacesSource.isConfigured", () => {
  // Clear both unified + legacy aliases; googleApiKey() walks all three.
  // resetEnvCache() so the next loadEnv() sees the cleared state.
  const originalUnified = process.env.GOOGLE_API_KEY;
  const originalMaps = process.env.GOOGLE_MAPS_API_KEY;
  const originalPsi = process.env.PAGESPEED_API_KEY;

  beforeEach(() => {
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GOOGLE_MAPS_API_KEY;
    delete process.env.PAGESPEED_API_KEY;
    resetEnvCache();
  });

  afterEach(() => {
    if (originalUnified !== undefined) process.env.GOOGLE_API_KEY = originalUnified;
    if (originalMaps !== undefined) process.env.GOOGLE_MAPS_API_KEY = originalMaps;
    if (originalPsi !== undefined) process.env.PAGESPEED_API_KEY = originalPsi;
    resetEnvCache();
  });

  it("returns false when GOOGLE_MAPS_API_KEY is missing", () => {
    expect(googlePlacesSource.isConfigured()).toBe(false);
  });

  it("returns true when GOOGLE_MAPS_API_KEY is set", () => {
    process.env.GOOGLE_MAPS_API_KEY = "test-key";
    resetEnvCache();
    expect(googlePlacesSource.isConfigured()).toBe(true);
  });

  it("exposes the required identity fields", () => {
    expect(googlePlacesSource.id).toBe("google-places");
    expect(typeof googlePlacesSource.label).toBe("string");
    expect(googlePlacesSource.label.length).toBeGreaterThan(0);
  });
});

describe("DataSource interface conformance", () => {
  it("mock source satisfies the interface shape", async () => {
    const src = makeMockSource();
    expect(typeof src.id).toBe("string");
    expect(typeof src.label).toBe("string");
    expect(typeof src.isConfigured).toBe("function");
    expect(typeof src.search).toBe("function");
    const result = await src.search({ query: "x", maxResults: 1 });
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("selectActive", () => {
  it("filters out sources whose isConfigured() returns false", () => {
    const a = makeMockSource({ id: "a", isConfigured: () => true });
    const b = makeMockSource({ id: "b", isConfigured: () => false });
    const c = makeMockSource({ id: "c", isConfigured: () => true });

    const active = selectActive([a, b, c]);
    expect(active.map((s) => s.id)).toEqual(["a", "c"]);
  });

  it("throws when no source is configured", () => {
    const a = makeMockSource({ id: "a", isConfigured: () => false });
    const b = makeMockSource({ id: "b", isConfigured: () => false });

    expect(() => selectActive([a, b])).toThrow(/No DataSource configured/);
  });

  it("throws when given an empty source list", () => {
    expect(() => selectActive([])).toThrow(/No DataSource configured/);
  });
});

describe("ALL_SOURCES priority order", () => {
  // Pins the registry-priority used by discover.ts's per-seed fallback.
  // Flipping this order silently would switch the primary data source
  // for the whole pipeline; the test forces the change to be explicit.
  it("puts osm-overpass at index 0 (primary) and google-places at index 1", () => {
    expect(ALL_SOURCES[0]?.id).toBe("osm-overpass");
    expect(ALL_SOURCES[1]?.id).toBe("google-places");
  });
});
