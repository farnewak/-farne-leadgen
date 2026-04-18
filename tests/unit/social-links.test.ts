import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { extractSocialLinks } from "../../src/pipeline/social-links.js";

const FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/websites",
);

const fixture = (name: string): string =>
  readFileSync(resolve(FIXTURES, name), "utf8");

describe("extractSocialLinks", () => {
  it("extracts all 7 platforms from socials fixture", () => {
    const r = extractSocialLinks(fixture("socials.html"));
    expect(r.facebook).toContain("facebook.com/beispielbetrieb");
    expect(r.instagram).toContain("instagram.com/beispielbetrieb");
    expect(r.linkedin).toContain("linkedin.com/company/beispielbetrieb");
    expect(r.xing).toContain("xing.com/companies/beispielbetrieb");
    expect(r.twitter).toContain("twitter.com/beispielbetrieb");
    expect(r.youtube).toContain("youtube.com/@beispielbetrieb");
    expect(r.tiktok).toContain("tiktok.com/@beispielbetrieb");
  });

  it("ignores facebook sharer URLs", () => {
    const r = extractSocialLinks(
      `<a href="https://www.facebook.com/sharer/sharer.php?u=x">Share</a>`,
    );
    expect(r.facebook).toBeUndefined();
  });

  it("ignores twitter intent URLs", () => {
    const r = extractSocialLinks(
      `<a href="https://twitter.com/intent/tweet?url=x">Tweet</a>`,
    );
    expect(r.twitter).toBeUndefined();
  });

  it("accepts x.com as twitter alias", () => {
    const r = extractSocialLinks(
      `<a href="https://x.com/beispiel">Profile</a>`,
    );
    expect(r.twitter).toContain("x.com/beispiel");
  });

  it("returns empty object for HTML without social links", () => {
    const r = extractSocialLinks(`<html><body><h1>hi</h1></body></html>`);
    expect(r).toEqual({});
  });

  it("first-seen-wins on duplicates", () => {
    const r = extractSocialLinks(`
      <a href="https://www.facebook.com/first">first</a>
      <a href="https://www.facebook.com/second">second</a>
    `);
    expect(r.facebook).toContain("/first");
  });

  it("rejects root-only URLs without profile path", () => {
    const r = extractSocialLinks(
      `<a href="https://www.facebook.com/">FB</a>`,
    );
    expect(r.facebook).toBeUndefined();
  });

  it("handles de.linkedin.com and m.facebook.com subdomains", () => {
    const r = extractSocialLinks(`
      <a href="https://de.linkedin.com/company/acme">LI</a>
      <a href="https://m.facebook.com/acme">FB</a>
    `);
    expect(r.linkedin).toContain("linkedin.com/company/acme");
    expect(r.facebook).toContain("facebook.com/acme");
  });

  it("returns empty on empty HTML", () => {
    expect(extractSocialLinks("")).toEqual({});
  });
});
