import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PlaceCandidate } from "../../src/models/types.js";
import {
  classifyChainCandidate,
  filterChains,
} from "../../src/tools/filters/chain-filter.js";

interface MatrixCase {
  label: string;
  name: string;
  types: string[];
  expectedKept: boolean;
  expectedReason: string;
}

interface Matrix {
  positiveDrop: MatrixCase[];
  premiumKeep: MatrixCase[];
  falsePositiveGuards: MatrixCase[];
  edgeCases: MatrixCase[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
const matrix = JSON.parse(
  readFileSync(
    resolve(HERE, "../fixtures/chain-filter-matrix.json"),
    "utf-8",
  ),
) as Matrix;

function makeCandidate(name: string, types: string[]): PlaceCandidate {
  return {
    placeId: `test:${name}`,
    name,
    address: null,
    plz: null,
    district: null,
    types,
    primaryType: null,
    website: null,
    phone: null,
    lat: 48.2,
    lng: 16.37,
  };
}

function runCase(c: MatrixCase): void {
  const decision = classifyChainCandidate(makeCandidate(c.name, c.types));
  expect(decision.kept).toBe(c.expectedKept);
  expect(decision.reason).toBe(c.expectedReason);
}

describe("chain-filter: positive-drop (real B2C chains)", () => {
  for (const c of matrix.positiveDrop) {
    it(`drops ${c.label}`, () => runCase(c));
  }
});

describe("chain-filter: premium-keep (whitelist precedence)", () => {
  for (const c of matrix.premiumKeep) {
    it(`keeps ${c.label}`, () => runCase(c));
  }
});

describe("chain-filter: false-positive guards", () => {
  for (const c of matrix.falsePositiveGuards) {
    it(`keeps ${c.label}`, () => runCase(c));
  }
});

describe("chain-filter: edge cases", () => {
  for (const c of matrix.edgeCases) {
    it(`handles ${c.label}`, () => runCase(c));
  }
});

describe("chain-filter: matrix scale", () => {
  it("covers at least 25 cases across all buckets", () => {
    const total =
      matrix.positiveDrop.length +
      matrix.premiumKeep.length +
      matrix.falsePositiveGuards.length +
      matrix.edgeCases.length;
    expect(total).toBeGreaterThanOrEqual(25);
  });
});

describe("chain-filter: filterChains integration", () => {
  const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];

  beforeEach(() => {
    consoleSpies.push(vi.spyOn(console, "log").mockImplementation(() => {}));
    consoleSpies.push(vi.spyOn(console, "warn").mockImplementation(() => {}));
    consoleSpies.push(vi.spyOn(console, "error").mockImplementation(() => {}));
  });

  afterEach(() => {
    for (const s of consoleSpies) s.mockRestore();
    consoleSpies.length = 0;
    vi.restoreAllMocks();
  });

  it("drops only chain-tagged candidates and preserves object identity", () => {
    const input: PlaceCandidate[] = [
      makeCandidate("Billa", ["shop=supermarket", "brand:Billa"]),
      makeCandidate("Juwelier Heldwein", ["shop=jewelry"]),
      makeCandidate("Anwaltskanzlei Dr. Müller", ["office=lawyer"]),
      makeCandidate("OMV Tankstelle", ["amenity=fuel", "brand:OMV"]),
      makeCandidate("Dorotheum", ["amenity=auction_house"]),
    ];
    const out = filterChains(input);
    expect(out.map((c) => c.name)).toEqual([
      "Juwelier Heldwein",
      "Anwaltskanzlei Dr. Müller",
      "Dorotheum",
    ]);
    // object identity preserved — no cloning
    expect(out[0]).toBe(input[1]);
  });

  it("preserves subtype information via generic", () => {
    interface WithIndustry extends PlaceCandidate {
      industry: string;
    }
    const input: WithIndustry[] = [
      { ...makeCandidate("Spar", ["shop=supermarket", "brand:Spar"]), industry: "retail" },
      { ...makeCandidate("Galerie Nächst St. Stephan", ["shop=art"]), industry: "retail" },
    ];
    const out = filterChains(input);
    // TS-level: out is WithIndustry[], industry is readable
    expect(out[0]?.industry).toBe("retail");
    expect(out).toHaveLength(1);
  });

  it("snapshot: logging format for dropped candidate", () => {
    const logSpy = consoleSpies[0]!;
    filterChains([
      makeCandidate("Billa", ["shop=supermarket", "brand:Billa"]),
    ]);
    const joined = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(joined).toContain("[INFO]");
    expect(joined).toContain("[chain-filter]");
    expect(joined).toContain('"placeId":"test:Billa"');
    expect(joined).toContain('"name":"Billa"');
    expect(joined).toContain('"kept":false');
    expect(joined).toContain('"reason":"blacklist:shop=supermarket:billa"');
  });

  it("snapshot: logging format for kept candidate (debug level suppressed at info)", () => {
    const logSpy = consoleSpies[0]!;
    filterChains([makeCandidate("Juwelier Heldwein", ["shop=jewelry"])]);
    const joined = logSpy.mock.calls.map((c) => c.join(" ")).join("\n");
    // At default info threshold, kept decisions only show via the
    // aggregate "dropped N/M" line — which is absent here because
    // nothing was dropped.
    expect(joined).not.toContain("dropped");
  });
});
