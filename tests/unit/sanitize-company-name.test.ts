import { describe, it, expect } from "vitest";
import {
  sanitizeCompanyName,
  NAME_STOP_KEYWORDS,
} from "../../src/pipeline/sanitize-company-name.js";

describe("sanitizeCompanyName", () => {
  it("returns null for null / undefined / empty", () => {
    expect(sanitizeCompanyName(null)).toBeNull();
    expect(sanitizeCompanyName(undefined as unknown as string)).toBeNull();
    expect(sanitizeCompanyName("")).toBeNull();
    expect(sanitizeCompanyName("   ")).toBeNull();
  });

  it("returns null when shorter than 3 chars after processing", () => {
    expect(sanitizeCompanyName("ab")).toBeNull();
    // Stop-keyword at index 1 leaves "A" which is <3 chars → null.
    expect(sanitizeCompanyName("A Telefon: 0123")).toBeNull();
  });

  it("cuts at first newline", () => {
    expect(
      sanitizeCompanyName("Fladerei GmbH\nMariahilfer Str. 1"),
    ).toBe("Fladerei GmbH");
    expect(sanitizeCompanyName("Foo AG\r\nBar")).toBe("Foo AG");
  });

  it("cuts before stop-keyword (case-insensitive)", () => {
    expect(sanitizeCompanyName("Fladerei GmbH Telefon: 0123")).toBe(
      "Fladerei GmbH",
    );
    expect(sanitizeCompanyName("Fladerei GmbH telefon: 0123")).toBe(
      "Fladerei GmbH",
    );
    expect(sanitizeCompanyName("Fladerei GmbH TELEFON: 0123")).toBe(
      "Fladerei GmbH",
    );
  });

  it("hard-caps at 80 chars", () => {
    const longClean = "A".repeat(150);
    const out = sanitizeCompanyName(longClean);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(80);
  });

  it("strips trailing separator/punctuation but keeps legal-form dot", () => {
    expect(sanitizeCompanyName("Fladerei GmbH - ")).toBe("Fladerei GmbH");
    expect(sanitizeCompanyName("Fladerei GmbH, ")).toBe("Fladerei GmbH");
    expect(sanitizeCompanyName("Fladerei GmbH; ")).toBe("Fladerei GmbH");
    expect(sanitizeCompanyName("Fladerei GmbH | ")).toBe("Fladerei GmbH");
    // "e.U." legal-form dot must survive (strip list excludes `.`).
    expect(sanitizeCompanyName("Schmidt Consulting e.U.")).toBe(
      "Schmidt Consulting e.U.",
    );
  });

  it("leaves clean short names untouched", () => {
    expect(sanitizeCompanyName("Dr. Kankovsky KG")).toBe("Dr. Kankovsky KG");
    expect(sanitizeCompanyName("Fladerei GmbH")).toBe("Fladerei GmbH");
  });

  it("covers the 17 required stop keywords", () => {
    // Guard: the GOAL demands these exact 17 keywords. If anyone trims the
    // list, this test fails and forces a conscious decision.
    const required = [
      "Telefon",
      "Fax",
      "E-Mail",
      "UID",
      "ATU",
      "Firmenbuch",
      "Gerichtsstand",
      "Handelsgericht",
      "Unternehmensgegenstand",
      "Geschäftsführer",
      "Medieninhaber",
      "Adresse",
      "Website",
      "Impressum",
      "Datenschutz",
      "Menü",
      "Speisekarte",
      "Öffnungszeiten",
    ];
    for (const kw of required) {
      expect(NAME_STOP_KEYWORDS).toContain(kw);
    }
  });

  it("strips the Apotheker-Verlag overflow pattern", () => {
    const stored =
      "Österreichische Apotheker-Verlagsgesellschaft m.b.H.Unternehmensgegenstand:Herausgabe und Verschleiß";
    expect(sanitizeCompanyName(stored)).toBe(
      "Österreichische Apotheker-Verlagsgesellschaft m.b.H.",
    );
  });
});
