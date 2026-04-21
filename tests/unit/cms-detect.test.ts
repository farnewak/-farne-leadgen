import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { detectCms } from "../../src/pipeline/cms-detect.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const F = (name: string): string =>
  readFileSync(resolve(HERE, "../fixtures/cms", name), "utf-8");

// FIX 10 — cascaded CMS detector. Each test pushes one fixture through
// detectCms end-to-end so the cascade order is exercised (Step A → B → C → D → E).

describe("detectCms — cascade", () => {
  it("Step A: existing fingerprint wins (wordpress from tech-stack)", () => {
    // Even with a body that would otherwise look static, a pre-matched
    // canonical slug on the existing tech-stack result takes over.
    const out = detectCms({
      body: F("static-fallback.html"),
      headers: {},
      existingCms: ["wordpress"],
    });
    expect(out.cms).toBe("wordpress");
  });

  it("Step A: non-canonical fingerprint ids are ignored, falls through", () => {
    const out = detectCms({
      body: F("static-fallback.html"),
      headers: {},
      existingCms: ["prestashop"], // not in canonical set
    });
    expect(out.cms).toBe("static_or_custom");
  });

  it("Step B: WordPress meta generator → wordpress", () => {
    const out = detectCms({
      body: F("wordpress-generator.html"),
      headers: {},
    });
    expect(out.cms).toBe("wordpress");
  });

  it("Step C: x-drupal-cache header → drupal (body has no fingerprint)", () => {
    const out = detectCms({
      body: F("drupal-header.html"),
      headers: { "x-drupal-cache": "HIT" },
    });
    expect(out.cms).toBe("drupal");
  });

  it("Step C: x-powered-by=PHP/7.4 alone does NOT set cms", () => {
    const out = detectCms({
      body: F("static-fallback.html"),
      headers: { "x-powered-by": "PHP/7.4" },
    });
    expect(out.cms).toBe("static_or_custom");
  });

  it("Step C: x-shopify-stage → shopify", () => {
    const out = detectCms({
      body: "<html><body>barely any content</body></html>",
      headers: { "x-shopify-stage": "production" },
    });
    expect(out.cms).toBe("shopify");
  });

  it("Step D: /typo3conf/ asset path → typo3", () => {
    const out = detectCms({ body: F("typo3-asset.html"), headers: {} });
    expect(out.cms).toBe("typo3");
  });

  it("Step D: /_next/ asset path → nextjs", () => {
    const out = detectCms({ body: F("nextjs-asset.html"), headers: {} });
    expect(out.cms).toBe("nextjs");
  });

  it("Step D: cdn.shopify.com → shopify", () => {
    const out = detectCms({ body: F("shopify-asset.html"), headers: {} });
    expect(out.cms).toBe("shopify");
  });

  it("Step D: assets.jimdofree.com → jimdo", () => {
    const out = detectCms({ body: F("jimdo-asset.html"), headers: {} });
    expect(out.cms).toBe("jimdo");
  });

  it("Step E: body present, no fingerprint → static_or_custom", () => {
    const out = detectCms({ body: F("static-fallback.html"), headers: {} });
    expect(out.cms).toBe("static_or_custom");
  });

  it("Step E: empty body → unknown (audit never reached CMS step)", () => {
    const out = detectCms({ body: "", headers: {} });
    expect(out.cms).toBe("unknown");
  });

  it("header name casing does not matter (defensive)", () => {
    const out = detectCms({
      body: "<html>a</html>",
      headers: { "X-Drupal-Cache": "HIT" },
    });
    expect(out.cms).toBe("drupal");
  });

  it("webflow asset path → webflow", () => {
    const body = "<html><link href='https://assets.website-files.com/x/main.css'></html>";
    const out = detectCms({ body, headers: {} });
    expect(out.cms).toBe("webflow");
  });

  it("weebly asset path → weebly", () => {
    const body = "<html><script src='https://cdn1.editmysite.weebly.com/main.js'></script></html>";
    const out = detectCms({ body, headers: {} });
    expect(out.cms).toBe("weebly");
  });

  it("fail-safe: malformed body does not throw", () => {
    // A non-string body would throw inside the regex; the function must
    // swallow and return the "unknown" sentinel instead.
    const out = detectCms({
      body: null as unknown as string,
      headers: {},
    });
    expect(out.cms).toBe("unknown");
  });

  it("meta generator: Next.js → nextjs", () => {
    const body = '<html><head><meta name="generator" content="Next.js"></head></html>';
    const out = detectCms({ body, headers: {} });
    expect(out.cms).toBe("nextjs");
  });

  it("meta generator: Joomla! → joomla", () => {
    const body =
      '<html><head><meta name="generator" content="Joomla! - Open Source CMS"></head></html>';
    const out = detectCms({ body, headers: {} });
    expect(out.cms).toBe("joomla");
  });
});
