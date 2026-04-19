import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PlaceCandidate } from "../../src/models/types.js";
import type {
  DataSource,
  DataSourceSearchOptions,
} from "../../src/tools/datasources/types.js";

// The registry mock lets us observe the DataSourceSearchOptions the
// pipeline passes down — that's where the bezirk scope lands as plzFilter.
const registryState: { sources: DataSource[] } = { sources: [] };

vi.mock("../../src/tools/datasources/registry.js", () => ({
  getActiveSources: () => registryState.sources,
  selectActive: (srcs: readonly DataSource[]) => [...srcs],
}));

import { discoverLeads } from "../../src/pipeline/discover.js";
import { buildOverpassQuery } from "../../src/tools/datasources/osm-overpass.js";

function makeCandidate(id: string, plz: string | null): PlaceCandidate {
  return {
    placeId: id,
    name: `name-${id}`,
    address: null,
    plz,
    district: null,
    types: ["restaurant"],
    primaryType: "restaurant",
    website: null,
    phone: null,
    lat: 48.2,
    lng: 16.37,
  };
}

describe("discoverLeads — bezirk scope", () => {
  const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeEach(() => {
    consoleSpies.push(vi.spyOn(console, "log").mockImplementation(() => {}));
    consoleSpies.push(vi.spyOn(console, "warn").mockImplementation(() => {}));
    consoleSpies.push(vi.spyOn(console, "error").mockImplementation(() => {}));
  });

  afterEach(() => {
    for (const s of consoleSpies) s.mockRestore();
    consoleSpies.length = 0;
    registryState.sources = [];
    vi.restoreAllMocks();
  });

  it("passes plz through DataSourceSearchOptions.plzFilter", async () => {
    const seen: Array<DataSourceSearchOptions> = [];
    const stub: DataSource = {
      id: "stub",
      label: "Stub",
      isConfigured: () => true,
      search: vi.fn(async (opts: DataSourceSearchOptions) => {
        seen.push(opts);
        // Deliver a mix: two candidates in 1010, one in 1020. Sources are
        // expected to apply plzFilter themselves; this stub skips that to
        // prove discoverLeads forwards the filter, not that it re-filters.
        return [
          makeCandidate(`${opts.query}-a`, "1010"),
          makeCandidate(`${opts.query}-b`, "1010"),
          makeCandidate(`${opts.query}-c`, "1020"),
        ];
      }),
    };
    registryState.sources = [stub];

    await discoverLeads({ plz: "1010", maxLeads: 10 });

    expect(seen.length).toBeGreaterThan(0);
    for (const opts of seen) {
      expect(opts.plzFilter).toBe("1010");
    }
  });

  it("no plz → plzFilter is null (regression guard)", async () => {
    const seen: Array<DataSourceSearchOptions> = [];
    const stub: DataSource = {
      id: "stub",
      label: "Stub",
      isConfigured: () => true,
      search: vi.fn(async (opts: DataSourceSearchOptions) => {
        seen.push(opts);
        return [];
      }),
    };
    registryState.sources = [stub];

    await discoverLeads({ plz: null, maxLeads: 5 });

    expect(seen.length).toBeGreaterThan(0);
    for (const opts of seen) {
      expect(opts.plzFilter).toBeNull();
    }
  });
});

describe("buildOverpassQuery — bezirk scope (spec §C I2)", () => {
  it("without plz keeps the Wien-wide admin-level=4 scope", () => {
    const q = buildOverpassQuery(180);
    expect(q).toContain(
      `area["name"="Wien"]["boundary"="administrative"]["admin_level"="4"]->.wien;`,
    );
    expect(q).toContain("(area.wien)");
    expect(q).not.toContain("->.bezirk");
  });

  it("with plz narrows the scope to the postal-code relation", () => {
    const q = buildOverpassQuery(180, "1030");
    expect(q).toContain(`area["postal_code"="1030"]->.bezirk;`);
    expect(q).toContain("(area.bezirk)");
    // And drops the Wien-wide area entirely.
    expect(q).not.toContain("->.wien");
    expect(q).not.toContain("(area.wien)");
  });
});
