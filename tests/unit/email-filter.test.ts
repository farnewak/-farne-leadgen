import { describe, it, expect } from "vitest";
import {
  GENERIC_BUSINESS_EMAIL_PREFIXES,
  isGenericBusinessEmail,
} from "../../src/pipeline/email-filter.js";

describe("isGenericBusinessEmail — prefix exact match", () => {
  it("accepts office@", () => {
    expect(isGenericBusinessEmail("office@example.at")).toBe(true);
  });
  it("accepts info@", () => {
    expect(isGenericBusinessEmail("info@example.at")).toBe(true);
  });
  it("accepts kontakt@", () => {
    expect(isGenericBusinessEmail("kontakt@example.at")).toBe(true);
  });
});

describe("isGenericBusinessEmail — rejects personal addresses", () => {
  it("rejects firstname.lastname@", () => {
    expect(isGenericBusinessEmail("max.mustermann@example.at")).toBe(false);
  });
  it("rejects an arbitrary personal handle", () => {
    expect(isGenericBusinessEmail("marie@example.at")).toBe(false);
  });
  it("rejects 'officer' (word that starts with 'office' but is not the prefix)", () => {
    // 'officer' continues the prefix with a letter, not . / - / _ / digit.
    expect(isGenericBusinessEmail("officer@example.at")).toBe(false);
  });
});

describe("isGenericBusinessEmail — prefix with suffix separators", () => {
  it("accepts office.wien@", () => {
    expect(isGenericBusinessEmail("office.wien@example.at")).toBe(true);
  });
  it("accepts office-vienna@", () => {
    expect(isGenericBusinessEmail("office-vienna@example.at")).toBe(true);
  });
  it("accepts info_at@", () => {
    expect(isGenericBusinessEmail("info_at@example.at")).toBe(true);
  });
  it("accepts info42@ (digit separator)", () => {
    expect(isGenericBusinessEmail("info42@example.at")).toBe(true);
  });
});

describe("isGenericBusinessEmail — case insensitivity", () => {
  it("accepts OFFICE@ uppercased", () => {
    expect(isGenericBusinessEmail("OFFICE@EXAMPLE.AT")).toBe(true);
  });
  it("accepts mixed-case Kontakt.Wien@", () => {
    expect(isGenericBusinessEmail("Kontakt.Wien@Example.at")).toBe(true);
  });
});

describe("isGenericBusinessEmail — malformed input", () => {
  it("rejects input without @", () => {
    expect(isGenericBusinessEmail("office")).toBe(false);
  });
  it("rejects empty local-part", () => {
    expect(isGenericBusinessEmail("@example.at")).toBe(false);
  });
});

describe("GENERIC_BUSINESS_EMAIL_PREFIXES", () => {
  it("contains the canonical trio at minimum", () => {
    expect(GENERIC_BUSINESS_EMAIL_PREFIXES).toContain("office");
    expect(GENERIC_BUSINESS_EMAIL_PREFIXES).toContain("info");
    expect(GENERIC_BUSINESS_EMAIL_PREFIXES).toContain("kontakt");
  });
});
