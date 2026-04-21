import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "cheerio";
import { extractCompanyName } from "../../src/pipeline/impressum-parsers.js";

const FIXTURE_DIR = resolve(
  process.cwd(),
  "tests/fixtures/name-leakage",
);

function bodyTextOf(fixturePath: string): string {
  const html = readFileSync(resolve(FIXTURE_DIR, fixturePath), "utf8");
  return load(html)("body").text();
}

const STOP_KEYWORDS = [
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

describe("extractCompanyName — name-leakage regression fixtures", () => {
  it("clean-baseline returns the exact clean legal-form name", () => {
    const body = bodyTextOf("clean-baseline.html");
    expect(extractCompanyName(body)).toBe("Fladerei GmbH");
  });

  it("kankovsky no longer overflows past the labelled name", () => {
    const body = bodyTextOf("kankovsky.html");
    const result = extractCompanyName(body);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(80);
    expect(result).not.toMatch(/[\r\n]/);
    for (const kw of STOP_KEYWORDS) {
      expect(result!.toLowerCase()).not.toContain(kw.toLowerCase());
    }
  });

  it("apotheker-verlag no longer overflows into Unternehmensgegenstand", () => {
    const body = bodyTextOf("apotheker-verlag.html");
    const result = extractCompanyName(body);
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(80);
    expect(result).not.toMatch(/[\r\n]/);
    for (const kw of STOP_KEYWORDS) {
      expect(result!.toLowerCase()).not.toContain(kw.toLowerCase());
    }
  });
});
