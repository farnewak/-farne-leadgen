import { describe, it, expect } from "vitest";
import {
  allBezirke,
  resolveBezirk,
} from "../../src/tools/geo/bezirk.js";

describe("allBezirke", () => {
  it("contains all 23 Vienna districts with unique PLZ", () => {
    const all = allBezirke();
    expect(all).toHaveLength(23);
    const plzs = all.map((b) => b.plz);
    expect(new Set(plzs).size).toBe(23);
    expect(plzs[0]).toBe("1010");
    expect(plzs[22]).toBe("1230");
  });
  it("PLZs follow the 1010..1230 step-10 schema", () => {
    for (const b of allBezirke()) {
      expect(b.plz).toMatch(/^1\d{2}0$/);
      expect(b.number).toBeGreaterThanOrEqual(1);
      expect(b.number).toBeLessThanOrEqual(23);
    }
  });
});

describe("resolveBezirk — PLZ form", () => {
  it("accepts every Wien PLZ 1010..1230", () => {
    for (const plz of ["1010", "1020", "1100", "1150", "1230"]) {
      expect(resolveBezirk(plz)?.plz).toBe(plz);
    }
  });
  it("rejects out-of-range PLZ", () => {
    expect(resolveBezirk("1240")).toBeNull();
    expect(resolveBezirk("2000")).toBeNull();
    expect(resolveBezirk("1121")).toBeNull(); // not a step-10 value
  });
});

describe("resolveBezirk — number form", () => {
  it("accepts 1..23", () => {
    expect(resolveBezirk("1")?.plz).toBe("1010");
    expect(resolveBezirk("3")?.plz).toBe("1030");
    expect(resolveBezirk("10")?.plz).toBe("1100");
    expect(resolveBezirk("23")?.plz).toBe("1230");
  });
  it("rejects 0 and 24+", () => {
    expect(resolveBezirk("0")).toBeNull();
    expect(resolveBezirk("24")).toBeNull();
    expect(resolveBezirk("99")).toBeNull();
  });
});

describe("resolveBezirk — name form", () => {
  it("resolves canonical names", () => {
    expect(resolveBezirk("Innere Stadt")?.plz).toBe("1010");
    expect(resolveBezirk("Leopoldstadt")?.plz).toBe("1020");
    expect(resolveBezirk("Landstraße")?.plz).toBe("1030");
    expect(resolveBezirk("Liesing")?.plz).toBe("1230");
  });
  it("is umlaut- and case-insensitive", () => {
    expect(resolveBezirk("landstrasse")?.plz).toBe("1030");
    expect(resolveBezirk("LANDSTRASSE")?.plz).toBe("1030");
    expect(resolveBezirk("Währing")?.plz).toBe("1180");
    expect(resolveBezirk("waehring")?.plz).toBe("1180");
  });
  it("rejects unknown names", () => {
    expect(resolveBezirk("Atlantis")).toBeNull();
    expect(resolveBezirk("")).toBeNull();
  });
});
