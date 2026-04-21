import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  generateCandidates,
  validatesCandidate,
  discoverViaDns,
} from "../../src/pipeline/dns-probe.js";
import type { PlaceCandidate } from "../../src/models/types.js";

function mkCandidate(p: Partial<PlaceCandidate>): PlaceCandidate {
  return {
    placeId: "test:1",
    name: "Test Business",
    address: null,
    plz: null,
    district: null,
    types: [],
    primaryType: null,
    website: null,
    phone: null,
    lat: 0,
    lng: 0,
    ...p,
  };
}

describe("generateCandidates", () => {
  it("produces up to 6 candidates for a multi-word name", () => {
    const out = generateCandidates("Gasthaus zum Ochsen");
    expect(out.length).toBeGreaterThan(0);
    expect(out.length).toBeLessThanOrEqual(6);
    for (const c of out) {
      expect(c.length).toBeLessThanOrEqual(63);
    }
  });

  it("normalizes umlauts and strips company suffixes", () => {
    const out = generateCandidates("Müller & Co GmbH");
    // slugify lower-cases, maps ü→ue, turns & into "and"
    const joined = out.join(" ");
    expect(joined).toMatch(/mueller/);
    expect(joined).not.toMatch(/ü/);
  });

  it("returns empty array when slug is empty", () => {
    expect(generateCandidates("!!!")).toEqual([]);
  });

  it("dedupes (e.g. name whose first word IS the full slug)", () => {
    const out = generateCandidates("Brezelbäckerei");
    // full-slug and first-word variants overlap → uniqueness preserved
    expect(new Set(out).size).toBe(out.length);
  });
});

describe("validatesCandidate", () => {
  it("accepts HTML with two+ significant name tokens", () => {
    const html = "<html><body>Willkommen im Gasthaus Ochsen in Wien</body></html>";
    const c = mkCandidate({ name: "Gasthaus zum Ochsen" });
    expect(validatesCandidate(html, c)).toBe(true);
  });

  it("rejects unrelated content", () => {
    const html = "<html><body>Blumenladen seit 1980 in Graz</body></html>";
    const c = mkCandidate({ name: "Gasthaus zum Ochsen" });
    expect(validatesCandidate(html, c)).toBe(false);
  });

  it("accepts via PLZ match alone", () => {
    const html = "<html><body>Kontakt: 1030 Wien, Rasumofskygasse</body></html>";
    const c = mkCandidate({ name: "Foo Bar Baz", plz: "1030" });
    expect(validatesCandidate(html, c)).toBe(true);
  });

  it("accepts via phone last-7-digit match", () => {
    const html =
      "<html><body>Kontakt: Tel. 01 / 234 5678 · office@example.com</body></html>";
    const c = mkCandidate({ name: "Foo Bar Baz", phone: "+43 1 234 5678" });
    expect(validatesCandidate(html, c)).toBe(true);
  });

  it("rejects when only one significant name token matches", () => {
    // "Gasthaus" alone is 1 hit — need ≥2 significant words
    const html = "<html><body>Gasthaus Muster GmbH</body></html>";
    const c = mkCandidate({ name: "Gasthaus zum Ochsen" });
    expect(validatesCandidate(html, c)).toBe(false);
  });
});

describe("discoverViaDns — guardrails (FIX 2)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns DNS_PROBE_DISABLED when env var is not set to 'true'", async () => {
    // Default state: env unset → disabled. No DNS, no fetch, no throw.
    const r = await discoverViaDns(mkCandidate({ name: "Müller GmbH" }));
    expect(r).toEqual({ found: false, reason: "DNS_PROBE_DISABLED" });
  });

  it("returns DNS_PROBE_DISABLED when env var is 'false' or any non-'true' value", async () => {
    for (const v of ["false", "0", "off", "", "yes"]) {
      vi.stubEnv("DNS_PROBE_ENABLED", v);
      const r = await discoverViaDns(mkCandidate({ name: "Müller GmbH" }));
      expect(r).toEqual({ found: false, reason: "DNS_PROBE_DISABLED" });
    }
  });

  it("returns NO_NAME when name is null, undefined, or whitespace", async () => {
    vi.stubEnv("DNS_PROBE_ENABLED", "true");
    // Cast to bypass strict name typing — the pipeline does pass null names
    // through when OSM yields nameless records (see regression R3).
    for (const name of [null, undefined, "", "   ", "\t\n"]) {
      const c = { ...mkCandidate({}), name } as unknown as PlaceCandidate;
      const r = await discoverViaDns(c);
      expect(r).toEqual({ found: false, reason: "NO_NAME" });
    }
  });

  it("returns BRANCH_NAME for 'Filiale' / 'Standort' / 'Zweigstelle' names", async () => {
    vi.stubEnv("DNS_PROBE_ENABLED", "true");
    for (const name of [
      "Spar Filiale 1030",
      "EUROSPAR Standort Landstraße",
      "Bank Zweigstelle Mitte",
      "FILIALE Wien",
    ]) {
      const r = await discoverViaDns(mkCandidate({ name }));
      expect(r).toEqual({ found: false, reason: "BRANCH_NAME" });
    }
  });

  it("branch-name guard is umlaut-folded and case-insensitive", async () => {
    vi.stubEnv("DNS_PROBE_ENABLED", "true");
    const r = await discoverViaDns(
      mkCandidate({ name: "Filiale München-West" }),
    );
    expect(r).toEqual({ found: false, reason: "BRANCH_NAME" });
  });
});
