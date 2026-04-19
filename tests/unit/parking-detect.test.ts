import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectParking,
  listFingerprintIds,
} from "../../src/tools/probe/parking-detect.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, "../fixtures/parking");

function load(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf8");
}

// Each entry is (fixture-file, expected-fingerprint-id, final-url-host).
// The 8 "parked" fixtures collectively exercise the fingerprint library —
// at least one per provider. coming-soon covers the generic "under-construction"
// branch; whmcs covers the hosting-default branch.
const PARKED_CASES: ReadonlyArray<{
  file: string;
  fingerprint: string;
  finalUrl: string;
}> = [
  { file: "sedo.html", fingerprint: "sedo", finalUrl: "https://examplepark.at/" },
  { file: "godaddy.html", fingerprint: "godaddy", finalUrl: "https://parked-at-godaddy.at/" },
  { file: "namecheap.html", fingerprint: "namecheap", finalUrl: "https://parked.example.at/" },
  { file: "ionos.html", fingerprint: "ionos", finalUrl: "https://ionos-placeholder.at/" },
  { file: "parkingcrew.html", fingerprint: "parkingcrew", finalUrl: "https://example-park.at/" },
  { file: "bodis.html", fingerprint: "bodis", finalUrl: "https://example-bodis.at/" },
  { file: "server-default.html", fingerprint: "server-default", finalUrl: "https://defaulted.at/" },
  { file: "coming-soon.html", fingerprint: "coming-soon", finalUrl: "https://soon.at/" },
];

const LEGIT_CASES: ReadonlyArray<{ file: string; finalUrl: string }> = [
  { file: "legit-bakery.html", finalUrl: "https://baeckerei-huber-wien.at/" },
  { file: "legit-kiosk.html", finalUrl: "https://kiosk-am-eck.at/" },
  { file: "legit-friseur.html", finalUrl: "https://salon-bella-wien.at/" },
];

describe("detectParking — parked fixtures", () => {
  for (const c of PARKED_CASES) {
    it(`flags ${c.file} as parked (fingerprint: ${c.fingerprint})`, () => {
      const body = load(c.file);
      const r = detectParking({ body, finalUrl: c.finalUrl });
      expect(r.verdict).toBe("parked");
      expect(r.fingerprint).toBe(c.fingerprint);
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

describe("detectParking — edge cases", () => {
  it("empty body returns parked (empty-html fingerprint)", () => {
    const r = detectParking({ body: "", finalUrl: "https://foo.at/" });
    expect(r.verdict).toBe("parked");
    expect(r.fingerprint).toBe("empty-html");
  });

  it("title-only body returns parked (empty-html)", () => {
    const body = "<html><head><title>x</title></head><body></body></html>";
    const r = detectParking({ body, finalUrl: "https://foo.at/" });
    expect(r.verdict).toBe("parked");
  });

  it("exposes the full fingerprint inventory", () => {
    const ids = listFingerprintIds();
    // Spec requires detectors for: sedo, godaddy, namecheap, ionos,
    // parkingcrew, bodis, server-default, coming-soon, empty-html, whmcs-cpanel.
    expect(ids).toEqual(
      expect.arrayContaining([
        "sedo",
        "godaddy",
        "namecheap",
        "ionos",
        "parkingcrew",
        "bodis",
        "server-default",
        "coming-soon",
        "empty-html",
        "whmcs-cpanel",
      ]),
    );
  });

  it("whmcs-cpanel fixture is flagged", () => {
    const body = load("whmcs.html");
    const r = detectParking({ body, finalUrl: "https://hosted.at/" });
    expect(r.verdict).toBe("parked");
    expect(r.fingerprint).toBe("whmcs-cpanel");
  });
});
