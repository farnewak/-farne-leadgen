import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PlaceCandidate } from "../../src/models/types.js";
import type {
  DataSource,
  DataSourceSearchOptions,
} from "../../src/tools/datasources/types.js";
import { searchSeedWithFallback } from "../../src/pipeline/discover.js";

function makeCandidate(id: string): PlaceCandidate {
  return {
    placeId: id,
    name: `name-${id}`,
    address: null,
    plz: null,
    district: null,
    types: [],
    primaryType: null,
    website: null,
    phone: null,
    lat: 48.2,
    lng: 16.37,
  };
}

function makeSource(
  id: string,
  impl: (opts: DataSourceSearchOptions) => Promise<PlaceCandidate[]>,
): DataSource {
  return {
    id,
    label: id,
    isConfigured: () => true,
    search: vi.fn(impl),
  };
}

const baseOptions: DataSourceSearchOptions = {
  query: "Café Wien",
  maxResults: 10,
  plzFilter: null,
};

describe("searchSeedWithFallback", () => {
  const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeEach(() => {
    // Silence logger output but still let vi.fn spies on console work.
    consoleSpies.push(vi.spyOn(console, "log").mockImplementation(() => {}));
    consoleSpies.push(vi.spyOn(console, "warn").mockImplementation(() => {}));
    consoleSpies.push(vi.spyOn(console, "error").mockImplementation(() => {}));
  });

  afterEach(() => {
    for (const s of consoleSpies) s.mockRestore();
    consoleSpies.length = 0;
    vi.restoreAllMocks();
  });

  it("T-DF-1: primary success → secondary not called", async () => {
    const candidates = [makeCandidate("a"), makeCandidate("b")];
    const primary = makeSource("primary", async () => candidates);
    const secondary = makeSource("secondary", async () => [
      makeCandidate("z"),
    ]);

    const result = await searchSeedWithFallback(
      baseOptions,
      [primary, secondary],
      "Café",
    );

    expect(result.sourceId).toBe("primary");
    expect(result.places).toEqual(candidates);
    expect(secondary.search).toHaveBeenCalledTimes(0);
    expect(primary.search).toHaveBeenCalledTimes(1);
  });

  it("T-DF-2: primary throws → secondary called with same seed, its result returned", async () => {
    const secondaryResult = [makeCandidate("s1"), makeCandidate("s2")];
    const primary = makeSource("primary", async () => {
      throw new Error("overpass 504");
    });
    const secondary = makeSource("secondary", async () => secondaryResult);

    const result = await searchSeedWithFallback(
      baseOptions,
      [primary, secondary],
      "Café",
    );

    expect(result.sourceId).toBe("secondary");
    expect(result.places).toEqual(secondaryResult);
    expect(secondary.search).toHaveBeenCalledTimes(1);
    expect(secondary.search).toHaveBeenCalledWith(baseOptions);
  });

  it("T-DF-3: all sources throw → throws with seed + source count + cause", async () => {
    const err1 = new Error("overpass 504");
    const err2 = new Error("google quota");
    const primary = makeSource("primary", async () => {
      throw err1;
    });
    const secondary = makeSource("secondary", async () => {
      throw err2;
    });

    await expect(
      searchSeedWithFallback(baseOptions, [primary, secondary], "Friseur"),
    ).rejects.toMatchObject({
      message: 'discovery failed for seed "Friseur" after 2 source(s)',
      cause: err2,
    });
  });

  it("T-DF-4: primary resolves [] → secondary not called (empty ≠ error)", async () => {
    const primary = makeSource("primary", async () => []);
    const secondary = makeSource("secondary", async () => [
      makeCandidate("z"),
    ]);

    const result = await searchSeedWithFallback(
      baseOptions,
      [primary, secondary],
      "Geschäft",
    );

    expect(result.sourceId).toBe("primary");
    expect(result.places).toEqual([]);
    expect(secondary.search).toHaveBeenCalledTimes(0);
  });

  it("T-DF-5: fallback log (warn) carries seed, failedSource, failedSourceError, fallbackSource", async () => {
    const warnSpy = consoleSpies[1]!;
    const primary = makeSource("osm-overpass", async () => {
      throw new Error("ENOTFOUND invalid.example.invalid");
    });
    const secondary = makeSource("google-places", async () => [
      makeCandidate("g1"),
    ]);

    await searchSeedWithFallback(
      baseOptions,
      [primary, secondary],
      "Restaurant",
    );

    expect(warnSpy).toHaveBeenCalled();
    const joined = warnSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(joined).toContain('"seed":"Restaurant"');
    expect(joined).toContain('"failedSource":"osm-overpass"');
    expect(joined).toContain("ENOTFOUND");
    expect(joined).toContain('"fallbackSource":"google-places"');
  });

  it("T-DF-6: three sources, first two throw → third is used", async () => {
    const thirdResult = [makeCandidate("t1")];
    const first = makeSource("first", async () => {
      throw new Error("boom-1");
    });
    const second = makeSource("second", async () => {
      throw new Error("boom-2");
    });
    const third = makeSource("third", async () => thirdResult);

    const result = await searchSeedWithFallback(
      baseOptions,
      [first, second, third],
      "Bar",
    );

    expect(result.sourceId).toBe("third");
    expect(result.places).toEqual(thirdResult);
    expect(first.search).toHaveBeenCalledTimes(1);
    expect(second.search).toHaveBeenCalledTimes(1);
    expect(third.search).toHaveBeenCalledTimes(1);
  });
});
