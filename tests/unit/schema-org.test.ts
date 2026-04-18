import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { detectSchemaOrg } from "../../src/pipeline/schema-org.js";

const FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/websites",
);

const fixture = (name: string): string =>
  readFileSync(resolve(FIXTURES, name), "utf8");

describe("detectSchemaOrg", () => {
  it("extracts Restaurant + WebSite + BreadcrumbList from JSON-LD fixture", () => {
    const r = detectSchemaOrg(fixture("schemaorg-jsonld.html"));
    expect(r.hasSchemaOrg).toBe(true);
    expect(r.types).toContain("Restaurant");
    expect(r.types).toContain("WebSite");
    expect(r.types).toContain("BreadcrumbList");
  });

  it("falls back to microdata when JSON-LD is absent", () => {
    const r = detectSchemaOrg(fixture("schemaorg-microdata.html"));
    expect(r.hasSchemaOrg).toBe(true);
    expect(r.types).toContain("LocalBusiness");
    expect(r.types).toContain("Person");
  });

  it("returns hasSchemaOrg=false on plain HTML", () => {
    const r = detectSchemaOrg(fixture("plain-static.html"));
    expect(r.hasSchemaOrg).toBe(false);
    expect(r.types).toEqual([]);
  });

  it("ignores malformed JSON-LD silently", () => {
    const r = detectSchemaOrg(
      `<script type="application/ld+json">{ not valid json</script>`,
    );
    expect(r.hasSchemaOrg).toBe(false);
  });

  it("handles @graph nesting", () => {
    const r = detectSchemaOrg(`
      <script type="application/ld+json">
        { "@context": "https://schema.org",
          "@graph": [
            { "@type": "Organization", "name": "Acme" },
            { "@type": "WebSite", "url": "https://a.com" }
          ]
        }
      </script>
    `);
    expect(r.types).toContain("Organization");
    expect(r.types).toContain("WebSite");
  });

  it("handles array @type", () => {
    const r = detectSchemaOrg(`
      <script type="application/ld+json">
        { "@type": ["Organization", "LocalBusiness"], "name": "Acme" }
      </script>
    `);
    expect(r.types).toContain("Organization");
    expect(r.types).toContain("LocalBusiness");
  });

  it("returns hasSchemaOrg=true even for uninteresting types", () => {
    const r = detectSchemaOrg(`
      <script type="application/ld+json">
        { "@type": "ObscureTypeNobodyUses", "name": "x" }
      </script>
    `);
    expect(r.hasSchemaOrg).toBe(true);
    expect(r.types).toEqual([]);
  });

  it("accepts http://schema.org/ itemtype as well as https", () => {
    const r = detectSchemaOrg(
      `<div itemscope itemtype="http://schema.org/Article"></div>`,
    );
    expect(r.types).toContain("Article");
  });

  it("returns false on empty html", () => {
    const r = detectSchemaOrg("");
    expect(r.hasSchemaOrg).toBe(false);
  });

  it("returns sorted types list", () => {
    const r = detectSchemaOrg(`
      <script type="application/ld+json">
        [{"@type":"WebSite"},{"@type":"Organization"},{"@type":"Article"}]
      </script>
    `);
    expect(r.types).toEqual(["Article", "Organization", "WebSite"]);
  });
});
