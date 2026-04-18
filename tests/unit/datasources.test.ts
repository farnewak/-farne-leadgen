import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { PlaceCandidate } from "../../src/models/types.js";
import type { DataSource, DataSourceSearchOptions } from "../../src/tools/datasources/types.js";
import { selectActive } from "../../src/tools/datasources/registry.js";
import { googlePlacesSource } from "../../src/tools/datasources/google-places.js";

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
  const originalKey = process.env.GOOGLE_MAPS_API_KEY;

  beforeEach(() => {
    delete process.env.GOOGLE_MAPS_API_KEY;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.GOOGLE_MAPS_API_KEY;
    } else {
      process.env.GOOGLE_MAPS_API_KEY = originalKey;
    }
  });

  it("returns false when GOOGLE_MAPS_API_KEY is missing", () => {
    expect(googlePlacesSource.isConfigured()).toBe(false);
  });

  it("returns true when GOOGLE_MAPS_API_KEY is set", () => {
    process.env.GOOGLE_MAPS_API_KEY = "test-key";
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
