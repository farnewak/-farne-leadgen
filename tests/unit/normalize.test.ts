import { describe, it, expect } from "vitest";
import { districtFromPlz } from "../../src/lib/normalize.js";

describe("districtFromPlz", () => {
  it("accepts valid Vienna PLZs 1010-1230", () => {
    expect(districtFromPlz("1010")).toBe("01");
    expect(districtFromPlz("1070")).toBe("07");
    expect(districtFromPlz("1230")).toBe("23");
  });
  it("rejects malformed Vienna PLZs (non-zero last digit)", () => {
    expect(districtFromPlz("1121")).toBeNull();
    expect(districtFromPlz("1232")).toBeNull();
    expect(districtFromPlz("1015")).toBeNull();
  });
  it("rejects non-Vienna PLZs", () => {
    expect(districtFromPlz("2000")).toBeNull();
    expect(districtFromPlz("9020")).toBeNull();
  });
  it("handles null/empty", () => {
    expect(districtFromPlz(null)).toBeNull();
    expect(districtFromPlz("")).toBeNull();
  });
});
