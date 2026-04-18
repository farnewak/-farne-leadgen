import { describe, it, expect } from "vitest";
import { OSM_TAG_TO_GPLACES_KEY, findOsmTagKey } from "../../src/pipeline/classify-osm.js";
import { classifyIndustry } from "../../src/pipeline/classify.js";
import type { Industry } from "../../src/models/types.js";

describe("OSM_TAG_TO_GPLACES_KEY", () => {
  it("maps amenity=restaurant → restaurant → gastronomy", () => {
    const gp = OSM_TAG_TO_GPLACES_KEY["amenity=restaurant"];
    expect(gp).toBe("restaurant");
    expect(classifyIndustry([], gp!)).toBe("gastronomy");
  });

  it("maps shop=hairdresser → hair_salon → beauty", () => {
    const gp = OSM_TAG_TO_GPLACES_KEY["shop=hairdresser"];
    expect(gp).toBe("hair_salon");
    expect(classifyIndustry([], gp!)).toBe("beauty");
  });

  it("maps office=lawyer → lawyer → services", () => {
    const gp = OSM_TAG_TO_GPLACES_KEY["office=lawyer"];
    expect(gp).toBe("lawyer");
    expect(classifyIndustry([], gp!)).toBe("services");
  });

  it("maps craft=plumber → plumber → crafts", () => {
    const gp = OSM_TAG_TO_GPLACES_KEY["craft=plumber"];
    expect(gp).toBe("plumber");
    expect(classifyIndustry([], gp!)).toBe("crafts");
  });

  it("maps shop=supermarket → supermarket → retail", () => {
    const gp = OSM_TAG_TO_GPLACES_KEY["shop=supermarket"];
    expect(gp).toBe("supermarket");
    expect(classifyIndustry([], gp!)).toBe("retail");
  });

  it("maps amenity=dentist → dentist → health", () => {
    const gp = OSM_TAG_TO_GPLACES_KEY["amenity=dentist"];
    expect(gp).toBe("dentist");
    expect(classifyIndustry([], gp!)).toBe("health");
  });

  it("returns undefined for keys outside the map", () => {
    expect(OSM_TAG_TO_GPLACES_KEY["shop=deli"]).toBeUndefined();
    expect(OSM_TAG_TO_GPLACES_KEY["amenity=fuel"]).toBeUndefined();
  });

  it("classifyIndustry falls back to 'other' for unmapped gplaces-key", () => {
    expect(classifyIndustry([], "unknown_type")).toBe("other");
  });

  it("every mapping resolves to one of the 6 concrete industries", () => {
    const seen = new Set<Industry>();
    for (const gp of Object.values(OSM_TAG_TO_GPLACES_KEY)) {
      const ind = classifyIndustry([], gp);
      expect(ind).not.toBe("other");
      seen.add(ind);
    }
    expect(seen.has("gastronomy")).toBe(true);
    expect(seen.has("retail")).toBe(true);
    expect(seen.has("services")).toBe(true);
    expect(seen.has("health")).toBe(true);
    expect(seen.has("beauty")).toBe(true);
    expect(seen.has("crafts")).toBe(true);
  });
});

describe("findOsmTagKey", () => {
  it("returns the first matching tag by mapping order", () => {
    expect(findOsmTagKey({ amenity: "restaurant", cuisine: "italian" })).toBe(
      "amenity=restaurant",
    );
  });

  it("returns null when no tag matches the map", () => {
    expect(findOsmTagKey({ amenity: "fuel" })).toBeNull();
    expect(findOsmTagKey({})).toBeNull();
  });

  it("handles healthcare tags that coexist with shop tags", () => {
    // Element with BOTH healthcare=optometrist and shop=optician. Iteration
    // order picks healthcare first (it appears earlier in the map).
    const tags = { healthcare: "optometrist", shop: "optician", name: "Optik" };
    expect(findOsmTagKey(tags)).toBe("healthcare=optometrist");
  });
});
