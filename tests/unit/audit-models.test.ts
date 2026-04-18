import { describe, it, expect } from "vitest";
import {
  TIERS,
  DISCOVERY_METHODS,
  FETCH_ERRORS,
  TechStackSignalsSchema,
  SocialLinksSchema,
  ImpressumDataSchema,
} from "../../src/models/audit.js";

describe("TechStackSignalsSchema", () => {
  it("parses {} to all six buckets as empty arrays", () => {
    const parsed = TechStackSignalsSchema.parse({});
    expect(parsed).toEqual({
      cms: [],
      pageBuilder: [],
      analytics: [],
      tracking: [],
      payment: [],
      cdn: [],
    });
  });
});

describe("SocialLinksSchema", () => {
  it("rejects 'not-a-url'", () => {
    const res = SocialLinksSchema.safeParse({ facebook: "not-a-url" });
    expect(res.success).toBe(false);
  });

  it("accepts valid URLs and leaves unset platforms undefined", () => {
    const res = SocialLinksSchema.parse({
      facebook: "https://facebook.com/foo",
    });
    expect(res.facebook).toBe("https://facebook.com/foo");
    expect(res.instagram).toBeUndefined();
  });
});

describe("ImpressumDataSchema", () => {
  const base = {
    present: true,
    url: "https://example.at/impressum",
    companyName: "Foo GmbH",
    address: "Mariahilfer Str. 1, 1070 Wien",
    phone: "+43 1 234 5678",
    email: "office@example.at",
    complete: true,
  } as const;

  it("accepts uid 'ATU12345678'", () => {
    const res = ImpressumDataSchema.safeParse({
      ...base,
      uid: "ATU12345678",
    });
    expect(res.success).toBe(true);
  });

  it("rejects uid 'ATU1234'", () => {
    const res = ImpressumDataSchema.safeParse({ ...base, uid: "ATU1234" });
    expect(res.success).toBe(false);
  });

  it("accepts uid null", () => {
    const res = ImpressumDataSchema.safeParse({ ...base, uid: null });
    expect(res.success).toBe(true);
  });
});

describe("enum tuples", () => {
  // readonly tuples carry literal types; checking .length + element identity
  // ensures accidental string[] widening would flag in type-check.
  it("TIERS is the exact 5-tuple", () => {
    expect(TIERS.length).toBe(5);
    expect(TIERS).toEqual(["A", "B1", "B2", "B3", "C"]);
  });

  it("DISCOVERY_METHODS is the exact 5-tuple", () => {
    expect(DISCOVERY_METHODS.length).toBe(5);
    expect(DISCOVERY_METHODS).toEqual([
      "osm-tag",
      "gplaces-tag",
      "dns-probe",
      "cse",
      "manual",
    ]);
  });

  it("FETCH_ERRORS contains both transport and upstream-API codes", () => {
    // B1 defined the 9 transport codes; B4 added 6 upstream-API/robots codes.
    // Assert presence rather than exact length so future additions don't
    // force churn here — the concrete codes are what matter downstream.
    expect(FETCH_ERRORS).toContain("DNS_FAIL");
    expect(FETCH_ERRORS).toContain("UNKNOWN");
    expect(FETCH_ERRORS).toContain("RATE_LIMITED");
    expect(FETCH_ERRORS).toContain("ROBOTS_DISALLOWED");
  });
});
