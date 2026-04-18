import { describe, it, expect } from "vitest";
import {
  extractUid,
  extractPhone,
  extractAustriaAddress,
  extractCompanyName,
} from "../../src/pipeline/impressum-parsers.js";

describe("extractUid", () => {
  it("extracts standard ATU pattern", () => {
    expect(extractUid("UID-Nummer: ATU12345678")).toBe("ATU12345678");
  });

  it("tolerates whitespace between letters and digits", () => {
    expect(extractUid("UID: AT U 1234 5678")).toBe("ATU12345678");
  });

  it("returns null when no ATU pattern present", () => {
    expect(extractUid("nothing here")).toBeNull();
  });

  it("returns null on empty text", () => {
    expect(extractUid("")).toBeNull();
  });

  it("rejects too-few digits", () => {
    expect(extractUid("ATU123")).toBeNull();
  });

  it("returns first valid match when multiple exist", () => {
    expect(extractUid("first ATU11111111 then ATU22222222")).toBe(
      "ATU11111111",
    );
  });
});

describe("extractPhone", () => {
  it("extracts international +43 format", () => {
    const phone = extractPhone("Tel.: +43 1 234 5678");
    expect(phone).toContain("+43");
  });

  it("extracts 0043 format", () => {
    expect(extractPhone("0043 1 234 5678")).toContain("0043");
  });

  it("extracts 0-prefixed national format", () => {
    expect(extractPhone("Tel. 01 23456789")).toMatch(/01/);
  });

  it("handles dashes and slashes in formatting", () => {
    expect(extractPhone("+43-1-234-5678")).toContain("+43");
  });

  it("returns null when no phone present", () => {
    expect(extractPhone("just some text")).toBeNull();
  });

  it("rejects too-short digit runs", () => {
    expect(extractPhone("Code 01 23")).toBeNull();
  });
});

describe("extractAustriaAddress", () => {
  it("extracts street + PLZ + city", () => {
    const addr = extractAustriaAddress(
      "Hauptstraße 12, 1030 Wien, Österreich",
    );
    expect(addr).toContain("1030");
    expect(addr).toContain("Wien");
  });

  it("tolerates collapsed whitespace", () => {
    const addr = extractAustriaAddress(
      "Mariahilfer Str. 5  1070  Wien",
    );
    expect(addr).toContain("1070");
  });

  it("returns null when no PLZ present", () => {
    expect(extractAustriaAddress("Hauptstraße 12, Wien")).toBeNull();
  });

  it("returns null on empty text", () => {
    expect(extractAustriaAddress("")).toBeNull();
  });

  it("handles umlauts", () => {
    const addr = extractAustriaAddress("Währinger Gürtel 7, 1090 Wien");
    expect(addr).toContain("1090");
  });
});

describe("extractCompanyName", () => {
  it("extracts by GmbH legal form", () => {
    expect(extractCompanyName("Beispiel Handels GmbH, Wien")).toBe(
      "Beispiel Handels GmbH",
    );
  });

  it("extracts by labeled Firmenname", () => {
    expect(
      extractCompanyName("Firmenname: Acme Österreich AG Wien"),
    ).toContain("Acme Österreich");
  });

  it("extracts OG legal form", () => {
    expect(extractCompanyName("Musterfirma OG ist ein Betrieb")).toBe(
      "Musterfirma OG",
    );
  });

  it("extracts e.U. legal form", () => {
    expect(extractCompanyName("Schmidt Consulting e.U.")).toContain(
      "Schmidt Consulting",
    );
  });

  it("returns null when no legal form or label", () => {
    expect(extractCompanyName("just some body text")).toBeNull();
  });

  it("returns null on empty text", () => {
    expect(extractCompanyName("")).toBeNull();
  });
});
