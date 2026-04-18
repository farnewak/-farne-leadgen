import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { detectTechStack } from "../../src/pipeline/tech-stack.js";

const FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/websites",
);

const fixture = (name: string): string =>
  readFileSync(resolve(FIXTURES, name), "utf8");

describe("detectTechStack", () => {
  it("flags WordPress + Elementor + Google Analytics from fixture", () => {
    const { signals } = detectTechStack(fixture("wordpress-site.html"), {});
    expect(signals.cms).toContain("wordpress");
    expect(signals.pageBuilder).toContain("elementor");
    expect(signals.analytics).toContain("google-analytics");
  });

  it("flags Wix CMS from fixture", () => {
    const { signals } = detectTechStack(fixture("wix-site.html"), {});
    expect(signals.cms).toContain("wix");
  });

  it("flags Shopify + Stripe + Facebook Pixel from fixture", () => {
    const { signals } = detectTechStack(fixture("shopify-site.html"), {});
    expect(signals.cms).toContain("shopify");
    expect(signals.payment).toContain("stripe");
    expect(signals.tracking).toContain("facebook-pixel");
  });

  it("returns empty buckets for plain static HTML", () => {
    const { signals } = detectTechStack(fixture("plain-static.html"), {});
    expect(signals.cms).toEqual([]);
    expect(signals.pageBuilder).toEqual([]);
    expect(signals.analytics).toEqual([]);
    expect(signals.tracking).toEqual([]);
    expect(signals.payment).toEqual([]);
    expect(signals.cdn).toEqual([]);
  });

  it("detects Cloudflare CDN from headers alone", () => {
    const { signals } = detectTechStack("", {
      Server: "cloudflare",
      "CF-Ray": "abc123",
      "CF-Cache-Status": "HIT",
    });
    expect(signals.cdn).toContain("cloudflare");
  });

  it("requires at least 2 signal matches (false-positive protection)", () => {
    // Just the word "WordPress" in article text — no wp-content, wp-includes,
    // or generator tag. Should NOT register as WordPress.
    const { signals } = detectTechStack(
      `<html><body><p>I love WordPress for blogs!</p></body></html>`,
      {},
    );
    expect(signals.cms).not.toContain("wordpress");
  });

  it("matches cookies case-insensitively", () => {
    const { signals } = detectTechStack(
      `<html><body>
        <script src="https://www.googletagmanager.com/gtag/js?id=G-X"></script>
      </body></html>`,
      { "Set-Cookie": "_ga=GA1.1.abc; _gid=GA1.1.xyz" },
    );
    expect(signals.analytics).toContain("google-analytics");
  });

  it("truncates very large HTML bodies", () => {
    const prefix = "x".repeat(300_000);
    const { signals } = detectTechStack(
      `${prefix}<script>wp-content/plugins/elementor</script>`,
      {},
    );
    // The wp-content hint sits beyond the 256KB scan window → not detected.
    expect(signals.cms).not.toContain("wordpress");
  });

  it("detects Vercel via x-vercel-id header pair", () => {
    const { signals } = detectTechStack("", {
      Server: "Vercel",
      "x-vercel-id": "iad1::abc",
      "x-vercel-cache": "HIT",
    });
    expect(signals.cdn).toContain("vercel");
  });

  it("handles multi-value set-cookie arrays", () => {
    const { signals } = detectTechStack(
      `<html><body>
        <script>var _paq = []; var matomo_url = '//stats/matomo.js';</script>
      </body></html>`,
      { "set-cookie": "_pk_id.1.abc=value; _pk_ses.1.abc=ses" },
    );
    expect(signals.analytics).toContain("matomo");
  });
});
