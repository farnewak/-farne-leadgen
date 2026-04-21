import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectLastModifiedYear,
  MIN_YEAR,
} from "../../src/pipeline/last-modified-detect.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = resolve(HERE, "../fixtures/last-modified");
const NOW = new Date("2026-04-20T12:00:00.000Z");

function loadFixture(name: string): string {
  return readFileSync(resolve(FIXTURE_DIR, name), "utf-8");
}

describe("detectLastModifiedYear", () => {
  it("copyright range takes the second year", () => {
    const body = loadFixture("copyright-range-2018-2024.html");
    expect(detectLastModifiedYear({ body, headers: {}, now: NOW })).toEqual({
      year: 2024,
    });
  });

  it("single-year copyright returns that year", () => {
    const body = loadFixture("copyright-single-2012.html");
    expect(detectLastModifiedYear({ body, headers: {}, now: NOW })).toEqual({
      year: 2012,
    });
  });

  it("returns null when no signal is present in body or headers", () => {
    const body = loadFixture("no-signal.html");
    expect(detectLastModifiedYear({ body, headers: {}, now: NOW })).toEqual({
      year: null,
    });
  });

  it("time tags: max year across <time datetime> and meta property wins", () => {
    const body = loadFixture("time-tag-2023.html");
    expect(detectLastModifiedYear({ body, headers: {}, now: NOW })).toEqual({
      year: 2023,
    });
  });

  it("clamp rejects out-of-range years (e.g. © 2099 typo)", () => {
    const body = loadFixture("invalid-year-2099.html");
    expect(detectLastModifiedYear({ body, headers: {}, now: NOW })).toEqual({
      year: null,
    });
  });

  it("falls back to Last-Modified header when body has no signal", () => {
    const body = loadFixture("no-signal.html");
    const headers = { "last-modified": "Tue, 15 Mar 2022 08:30:00 GMT" };
    expect(detectLastModifiedYear({ body, headers, now: NOW })).toEqual({
      year: 2022,
    });
  });

  it("header lookup is case-insensitive", () => {
    const body = loadFixture("no-signal.html");
    const headers = { "Last-Modified": "Tue, 15 Mar 2022 08:30:00 GMT" };
    expect(detectLastModifiedYear({ body, headers, now: NOW })).toEqual({
      year: 2022,
    });
  });

  it("copyright step wins over a header (cascade order)", () => {
    const body = loadFixture("copyright-single-2012.html");
    const headers = { "last-modified": "Tue, 15 Mar 2022 08:30:00 GMT" };
    expect(detectLastModifiedYear({ body, headers, now: NOW })).toEqual({
      year: 2012,
    });
  });

  it("null body does not crash the detector", () => {
    expect(detectLastModifiedYear({ body: null, headers: {}, now: NOW })).toEqual(
      { year: null },
    );
  });

  it("malformed Last-Modified header returns null", () => {
    expect(
      detectLastModifiedYear({
        body: "",
        headers: { "last-modified": "not-a-date" },
        now: NOW,
      }),
    ).toEqual({ year: null });
  });

  it("clamp boundary: MIN_YEAR is accepted", () => {
    const body = `<!doctype html><html><body><footer>&copy; ${MIN_YEAR} Edge</footer></body></html>`;
    expect(detectLastModifiedYear({ body, headers: {}, now: NOW })).toEqual({
      year: MIN_YEAR,
    });
  });

  it("clamp boundary: year below MIN_YEAR is rejected", () => {
    const body = `<!doctype html><html><body><footer>&copy; 1994 Too Old</footer></body></html>`;
    expect(detectLastModifiedYear({ body, headers: {}, now: NOW })).toEqual({
      year: null,
    });
  });

  it("meta property article:modified_time with reversed attribute order", () => {
    const body =
      '<!doctype html><html><head>' +
      '<meta content="2021-07-02T10:00:00Z" property="article:modified_time">' +
      "</head><body></body></html>";
    expect(detectLastModifiedYear({ body, headers: {}, now: NOW })).toEqual({
      year: 2021,
    });
  });
});
