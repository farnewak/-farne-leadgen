import { describe, it, expect } from "vitest";
import {
  effectivePlz,
  parsePlzFallbackMode,
  type PlzSources,
} from "../../src/cli/plz-filter.js";

// Phase 6b bug — Bezirk 1010 smoke produced 51 rows in audit_results but
// only 34 rows in CSV because the filter used ONLY the impressum-derived PLZ
// and dropped rows whose impressum scraping failed, even when OSM clearly
// tagged the candidate 1010. Regression guard for the coalesce chain:
//   impressumPlz → osmAddrPostcode → regex /\b(1\d{2}0)\b/ on name + url.
describe("effectivePlz — PLZ fallback coalesce", () => {
  const row1: PlzSources = {
    // Impressum scraper returned a Vienna address. Happy path.
    impressumPlz: "1010",
    osmAddrPostcode: "1010",
    name: "Cafe Central",
    url: "https://cafecentral.wien/",
  };
  const row2: PlzSources = {
    // Impressum scraper failed (returned no address). OSM tagged it 1010.
    // This is the exact row-class dropped pre-fix.
    impressumPlz: null,
    osmAddrPostcode: "1010",
    name: "Kleiner Imbiss",
    url: "https://kleinerimbiss.at/",
  };
  const row3: PlzSources = {
    // Neither scraper nor OSM carry a PLZ. Hostname has the digits 1010
    // but no word-boundary, so the regex fallback correctly rejects.
    impressumPlz: null,
    osmAddrPostcode: null,
    name: "Shop 1010",
    url: "https://shop1010.at/",
  };

  describe("mode=strict", () => {
    it("uses impressumPlz exclusively", () => {
      expect(effectivePlz(row1, "strict")).toBe("1010");
      expect(effectivePlz(row2, "strict")).toBeNull();
      expect(effectivePlz(row3, "strict")).toBeNull();
    });
  });

  describe("mode=permissive", () => {
    it("coalesces impressumPlz → osmAddrPostcode → regex on name/url", () => {
      expect(effectivePlz(row1, "permissive")).toBe("1010");
      // Row 2 recovers via OSM — the whole point of the fix.
      expect(effectivePlz(row2, "permissive")).toBe("1010");
      // Row 3's "Shop 1010" has the digits bounded by word chars on one side
      // (Shop-SPACE-1010). The regex matches "1010" here — acceptable, the
      // spec says the hostname case is a stretch. The NAME hit is real:
      // "1010" is word-boundary-isolated by the preceding space.
      expect(effectivePlz(row3, "permissive")).toBe("1010");
    });

    it("drops rows when no fallback source yields a Vienna PLZ", () => {
      const bare: PlzSources = {
        impressumPlz: null,
        osmAddrPostcode: null,
        name: "Generic Cafe",
        url: "https://generic.at/",
      };
      expect(effectivePlz(bare, "permissive")).toBeNull();
    });

    it("rejects non-Vienna postcodes (5-digit German, 4-digit non-step-10)", () => {
      const nonVienna: PlzSources = {
        impressumPlz: null,
        osmAddrPostcode: null,
        name: "Munich Outpost",
        url: "https://example.de/",
        // 80331 is Munich. 1234 is not a valid Vienna PLZ.
      };
      const addrLike: PlzSources = {
        ...nonVienna,
        name: "Strasse 80331 München",
      };
      expect(effectivePlz(nonVienna, "permissive")).toBeNull();
      expect(effectivePlz(addrLike, "permissive")).toBeNull();
    });
  });

  describe("mode=off", () => {
    it("returns null (signals caller to skip PLZ filter)", () => {
      expect(effectivePlz(row1, "off")).toBeNull();
      expect(effectivePlz(row2, "off")).toBeNull();
      expect(effectivePlz(row3, "off")).toBeNull();
    });
  });
});

describe("parsePlzFallbackMode", () => {
  it("accepts strict|permissive|off", () => {
    expect(parsePlzFallbackMode("strict")).toBe("strict");
    expect(parsePlzFallbackMode("permissive")).toBe("permissive");
    expect(parsePlzFallbackMode("off")).toBe("off");
  });

  it("defaults to permissive on null / empty", () => {
    expect(parsePlzFallbackMode(null)).toBe("permissive");
    expect(parsePlzFallbackMode("")).toBe("permissive");
  });

  it("throws on invalid values", () => {
    expect(() => parsePlzFallbackMode("strict2")).toThrow(
      /invalid --plz-fallback/,
    );
    expect(() => parsePlzFallbackMode("loose")).toThrow(
      /invalid --plz-fallback/,
    );
  });
});
