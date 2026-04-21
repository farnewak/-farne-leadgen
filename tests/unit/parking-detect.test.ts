import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectParking,
  listFingerprintIds,
  SIGNAL_IDS,
} from "../../src/tools/probe/parking-detect.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "../fixtures/parking");

function load(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf8");
}

// Small body + clear parking-text hit. These fixtures satisfy signals
// (a) small-body and (b) parking-text WITHOUT needing the Server header.
const PARKED_FIXTURE_TWO_SIGNAL: ReadonlyArray<{
  file: string;
  finalUrl: string;
}> = [
  { file: "sedo.html", finalUrl: "https://examplepark.at/" },
  { file: "namecheap.html", finalUrl: "https://parked.example.at/" },
  { file: "bodis.html", finalUrl: "https://example-bodis.at/" },
  { file: "coming-soon.html", finalUrl: "https://soon.at/" },
];

// Fixtures that only trip ONE of the body/title signals — the body is
// too large to count as small-body, and they don't name a parking
// vendor in the Server header. Under the strict 2-of-3 rule these must
// NOT be flagged as parked without additional evidence.
const SINGLE_SIGNAL_ONLY: ReadonlyArray<{
  file: string;
  finalUrl: string;
}> = [
  // godaddy.html is just above MIN_BODY_BYTES so only the parking-text
  // signal fires. Without a vendor Server header it stays non-parked.
  { file: "godaddy.html", finalUrl: "https://parked-at-godaddy.at/" },
];

const LEGIT_CASES: ReadonlyArray<{ file: string; finalUrl: string }> = [
  { file: "legit-bakery.html", finalUrl: "https://baeckerei-huber-wien.at/" },
  { file: "legit-kiosk.html", finalUrl: "https://kiosk-am-eck.at/" },
  { file: "legit-friseur.html", finalUrl: "https://salon-bella-wien.at/" },
];

describe("detectParking — two signals trigger parked verdict", () => {
  for (const c of PARKED_FIXTURE_TWO_SIGNAL) {
    it(`flags ${c.file} as parked (small-body + parking-text)`, () => {
      const body = load(c.file);
      const r = detectParking({ body, finalUrl: c.finalUrl });
      expect(r.verdict).toBe("parked");
      // Both expected signals must appear in the fingerprint string.
      expect(r.fingerprint).toContain("small-body");
      expect(r.fingerprint).toContain("parking-text");
    });
  }
});

describe("detectParking — legitimate small sites must NOT be flagged", () => {
  for (const c of LEGIT_CASES) {
    it(`does not flag ${c.file} as parked`, () => {
      const body = load(c.file);
      const r = detectParking({ body, finalUrl: c.finalUrl });
      expect(r.verdict).not.toBe("parked");
    });
  }
});

describe("detectParking — strict 2-of-3 rule: single-signal must NOT trigger", () => {
  // (a) small-body alone: a small, body-only HTML page with no parking
  // vocabulary and no Server header must stay "inconclusive", NEVER
  // "parked". This is exactly the R1/R2 regression scenario.
  it("single signal (a) small-body alone is inconclusive, not parked", () => {
    const body =
      "<!doctype html><html><head><title>Kleinmeister</title></head>" +
      "<body><h1>Kleinmeister Café</h1><p>Wipplingerstraße 14, 1010 Wien.</p>" +
      "</body></html>";
    const r = detectParking({ body, finalUrl: "https://kleinmeister.at/" });
    expect(r.verdict).toBe("inconclusive");
  });

  // (b) parking-text alone on a full-sized page. Large body + a stray
  // "godaddy" mention is not enough evidence.
  it("single signal (b) parking-text on a full-sized body is not parked", () => {
    const filler =
      "<p>" + "Filler filler filler filler filler filler ".repeat(40) + "</p>";
    const body =
      "<!doctype html><html><head><title>Agentur Test</title></head>" +
      "<body><h1>Willkommen</h1>" +
      "<p>Registriert über godaddy als Provider.</p>" +
      filler +
      "</body></html>";
    expect(body.length).toBeGreaterThanOrEqual(1024);
    const r = detectParking({ body, finalUrl: "https://agentur-test.at/" });
    expect(r.verdict).not.toBe("parked");
  });

  // (c) server-header alone on a full-sized page without parking text.
  // Mis-configured legitimate sites may share hosting with a vendor —
  // header alone is not enough.
  it("single signal (c) server-header alone on a full-sized healthy page is not parked", () => {
    const filler =
      "<p>" + "Filler filler filler filler filler filler ".repeat(40) + "</p>";
    const body =
      "<!doctype html><html><head><title>Salon Bella</title></head>" +
      "<body><h1>Salon Bella Wien</h1><p>Öffnungszeiten Montag bis Freitag.</p>" +
      filler +
      "</body></html>";
    expect(body.length).toBeGreaterThanOrEqual(1024);
    const r = detectParking({
      body,
      finalUrl: "https://salon-bella.at/",
      headers: { server: "ParkingCrew/1.0" },
    });
    expect(r.verdict).not.toBe("parked");
  });
});

describe("detectParking — strict 2-of-3 rule: two signals trigger parked", () => {
  it("(a)+(b) small-body + parking-text → parked", () => {
    const body =
      "<!doctype html><html><head><title>For Sale</title></head>" +
      "<body><p>This domain is for sale.</p></body></html>";
    const r = detectParking({ body, finalUrl: "https://xyz.at/" });
    expect(r.verdict).toBe("parked");
    expect(r.fingerprint).toBe("small-body+parking-text");
  });

  it("(a)+(c) small-body + server-header → parked", () => {
    const body =
      "<!doctype html><html><head><title>xyz.at</title></head>" +
      "<body><p>Landing page.</p></body></html>";
    const r = detectParking({
      body,
      finalUrl: "https://xyz.at/",
      headers: { Server: "Sedo Parking" },
    });
    expect(r.verdict).toBe("parked");
    expect(r.fingerprint).toBe("small-body+server-header");
  });

  it("(b)+(c) parking-text + server-header on a large body → parked", () => {
    const filler =
      "<p>" + "Filler filler filler filler filler filler ".repeat(40) + "</p>";
    const body =
      "<!doctype html><html><head><title>Coming Soon</title></head>" +
      "<body><h1>example.at</h1><p>buy this domain now.</p>" +
      filler +
      "</body></html>";
    expect(body.length).toBeGreaterThanOrEqual(1024);
    const r = detectParking({
      body,
      finalUrl: "https://example.at/",
      headers: { server: "Bodis/LL" },
    });
    expect(r.verdict).toBe("parked");
    expect(r.fingerprint).toBe("parking-text+server-header");
  });
});

describe("detectParking — single-signal vendor fixtures need a Server header to flip to parked", () => {
  for (const c of SINGLE_SIGNAL_ONLY) {
    it(`${c.file} alone stays non-parked, + vendor Server header → parked`, () => {
      const body = load(c.file);
      const bare = detectParking({ body, finalUrl: c.finalUrl });
      expect(bare.verdict).not.toBe("parked");
      const withHeader = detectParking({
        body,
        finalUrl: c.finalUrl,
        headers: { server: "Sedo Parking" },
      });
      expect(withHeader.verdict).toBe("parked");
    });
  }
});

describe("detectParking — edge cases", () => {
  it("empty body alone is a single signal → inconclusive", () => {
    const r = detectParking({ body: "", finalUrl: "https://foo.at/" });
    expect(r.verdict).toBe("inconclusive");
  });

  it("empty body + vendor Server header → parked (two signals)", () => {
    const r = detectParking({
      body: "",
      finalUrl: "https://foo.at/",
      headers: { server: "Sedo Parking" },
    });
    expect(r.verdict).toBe("parked");
  });

  it("exposes the signal-id inventory", () => {
    expect(listFingerprintIds()).toEqual([...SIGNAL_IDS]);
    expect(SIGNAL_IDS).toEqual(["small-body", "parking-text", "server-header"]);
  });
});
