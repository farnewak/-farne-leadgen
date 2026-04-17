import { describe, it, expect } from "vitest";
import { classifyIndustry, primaryCategoryKey } from "../../src/pipeline/classify.js";

describe("classifyIndustry", () => {
  it("prefers primaryType over types[]", () => {
    expect(
      classifyIndustry(["point_of_interest", "establishment"], "restaurant"),
    ).toBe("gastronomy");
  });

  it("falls back to first matching entry in types[]", () => {
    expect(
      classifyIndustry(["establishment", "bakery", "store"], null),
    ).toBe("gastronomy");
  });

  it("returns 'other' when nothing matches", () => {
    expect(
      classifyIndustry(["point_of_interest", "establishment"], "unknown_type"),
    ).toBe("other");
  });

  it("maps all seven industries correctly", () => {
    expect(classifyIndustry([], "cafe")).toBe("gastronomy");
    expect(classifyIndustry([], "clothing_store")).toBe("retail");
    expect(classifyIndustry([], "lawyer")).toBe("services");
    expect(classifyIndustry([], "dentist")).toBe("health");
    expect(classifyIndustry([], "hair_salon")).toBe("beauty");
    expect(classifyIndustry([], "plumber")).toBe("crafts");
    expect(classifyIndustry([], "amusement_park")).toBe("other");
  });

  it("is robust to empty input", () => {
    expect(classifyIndustry([], null)).toBe("other");
  });
});

describe("primaryCategoryKey", () => {
  it("returns primaryType when set", () => {
    expect(primaryCategoryKey(["food", "restaurant"], "cafe")).toBe("cafe");
  });

  it("falls back to first element of types[]", () => {
    expect(primaryCategoryKey(["food", "restaurant"], null)).toBe("food");
  });

  it("returns 'unknown' when nothing is provided", () => {
    expect(primaryCategoryKey([], null)).toBe("unknown");
  });
});
