import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PlaceCandidate } from "../../src/models/types.js";
import type {
  DataSource,
  DataSourceSearchOptions,
} from "../../src/tools/datasources/types.js";

// Mock the registry so discoverLeads() pulls our fake sources. vi.mock is
// hoisted, so the factory runs before the discover.ts import below.
const registryState: { sources: DataSource[] } = { sources: [] };

vi.mock("../../src/tools/datasources/registry.js", () => ({
  getActiveSources: () => registryState.sources,
  selectActive: (srcs: readonly DataSource[]) => [...srcs],
}));

import { discoverLeads } from "../../src/pipeline/discover.js";

function makeCandidate(id: string): PlaceCandidate {
  return {
    placeId: id,
    name: `name-${id}`,
    address: null,
    plz: null,
    district: null,
    types: ["restaurant"],
    primaryType: "restaurant",
    website: null,
    phone: null,
    lat: 48.2,
    lng: 16.37,
  };
}

describe("discoverLeads resilience: primary always throws, secondary always succeeds", () => {
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

  it("fills maxLeads=15 across 3 seeds via fake-secondary, primary is never fatal", async () => {
    const primary: DataSource = {
      id: "fake-primary",
      label: "Fake Primary",
      isConfigured: () => true,
      search: vi.fn(async () => {
        throw new Error("synthetic overpass-504");
      }),
    };

    let call = 0;
    const secondary: DataSource = {
      id: "fake-secondary",
      label: "Fake Secondary",
      isConfigured: () => true,
      search: vi.fn(async (_opts: DataSourceSearchOptions) => {
        const base = call;
        call += 1;
        return Array.from({ length: 5 }, (_, i) =>
          makeCandidate(`sec-${base}-${i}`),
        );
      }),
    };

    registryState.sources = [primary, secondary];

    const leads = await discoverLeads({ plz: null, maxLeads: 15 });

    // Three seeds × 5 candidates each = 15 distinct placeIds.
    expect(leads).toHaveLength(15);

    // Primary was called once per seed (3 times) and threw each time.
    expect(primary.search).toHaveBeenCalledTimes(3);

    // Secondary was called once per seed as the fallback.
    expect(secondary.search).toHaveBeenCalledTimes(3);

    // Sanity: placeIds are unique and reflect secondary's sequence.
    const ids = new Set(leads.map((l) => l.placeId));
    expect(ids.size).toBe(15);
    for (const id of ids) expect(id.startsWith("sec-")).toBe(true);
  });
});
