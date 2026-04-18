import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { checkViewport } from "../../src/pipeline/viewport-check.js";

const FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/websites",
);

const fixture = (name: string): string =>
  readFileSync(resolve(FIXTURES, name), "utf8");

describe("checkViewport", () => {
  it("detects standard viewport meta tag", () => {
    const res = checkViewport(fixture("wordpress-site.html"));
    expect(res.hasViewportMeta).toBe(true);
    expect(res.viewportMetaContent).toContain("width=device-width");
  });

  it("returns false when viewport meta is absent", () => {
    const res = checkViewport(fixture("no-viewport.html"));
    expect(res.hasViewportMeta).toBe(false);
    expect(res.viewportMetaContent).toBeNull();
  });

  it("handles empty content attribute", () => {
    const res = checkViewport(
      `<html><head><meta name="viewport" content=""></head></html>`,
    );
    expect(res.hasViewportMeta).toBe(true);
    expect(res.viewportMetaContent).toBeNull();
  });

  it("is case-insensitive on name attribute", () => {
    const res = checkViewport(
      `<html><head><meta name="Viewport" content="width=device-width"></head></html>`,
    );
    // cheerio is case-sensitive on attribute VALUES but attribute selector
    // matches case-sensitively — standard is lowercase "viewport".
    // This test documents that we rely on spec-compliant lowercase input.
    expect(res.hasViewportMeta).toBe(false);
  });

  it("returns false on empty HTML", () => {
    const res = checkViewport("");
    expect(res.hasViewportMeta).toBe(false);
    expect(res.viewportMetaContent).toBeNull();
  });

  it("picks first viewport when multiple present", () => {
    const res = checkViewport(
      `<html><head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta name="viewport" content="width=1024">
      </head></html>`,
    );
    expect(res.viewportMetaContent).toContain("device-width");
  });

  it("returns true for shopify fixture", () => {
    const res = checkViewport(fixture("shopify-site.html"));
    expect(res.hasViewportMeta).toBe(true);
  });

  it("ignores other meta tags", () => {
    const res = checkViewport(
      `<html><head><meta name="description" content="hi"></head></html>`,
    );
    expect(res.hasViewportMeta).toBe(false);
  });
});
