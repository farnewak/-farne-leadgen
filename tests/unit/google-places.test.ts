import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  extractPlz,
  toCandidate,
  type RawPlace,
} from "../../src/tools/datasources/google-places.js";

function baseRawPlace(overrides: Partial<RawPlace> = {}): RawPlace {
  return {
    id: "place-1",
    displayName: { text: "Test Business" },
    formattedAddress: "Mariahilferstr 99, 1060 Wien",
    location: { latitude: 48.2, longitude: 16.35 },
    types: ["cafe"],
    primaryType: "cafe",
    ...overrides,
  };
}

describe("extractPlz null-safety and Wien-PLZ strict", () => {
  it("addressComponent without `types` does not crash and falls back to formattedAddress", () => {
    const p: RawPlace = {
      id: "x",
      displayName: { text: "X" },
      addressComponents: [{ longText: "1010" }],
      formattedAddress: "Stephansplatz 1, 1010 Wien",
    };
    expect(extractPlz(p)).toBe("1010");
  });

  it("invalid Vienna PLZ (1121) in addressComponents is rejected", () => {
    const p: RawPlace = {
      id: "x",
      displayName: { text: "X" },
      addressComponents: [{ types: ["postal_code"], longText: "1121" }],
      formattedAddress: "Somewhere 1121, AT",
    };
    expect(extractPlz(p)).toBeNull();
  });

  it("valid Vienna PLZ is extracted from formattedAddress fallback", () => {
    const p: RawPlace = {
      id: "x",
      displayName: { text: "X" },
      formattedAddress: "Mariahilferstr 99, 1060 Wien",
    };
    expect(extractPlz(p)).toBe("1060");
  });
});

describe("toCandidate location-guard", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("drops place when location is missing", () => {
    const p: RawPlace = {
      id: "no-loc",
      displayName: { text: "NoLoc" },
      formattedAddress: "Somewhere 1010 Wien",
    };
    expect(toCandidate(p)).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("candidate with out-of-Vienna PLZ (1234) has plz=null and district=null", () => {
    const p = baseRawPlace({
      addressComponents: [{ types: ["postal_code"], longText: "1234" }],
      formattedAddress: "X 1234 Y",
    });
    const c = toCandidate(p);
    expect(c).not.toBeNull();
    expect(c?.plz).toBeNull();
    expect(c?.district).toBeNull();
  });
});
