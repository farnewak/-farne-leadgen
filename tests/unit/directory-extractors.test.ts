import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { load } from "cheerio";
import {
  EXTRACTORS,
  pickExtractor,
  isBlacklistedHost,
  normalizeUrl,
} from "../../src/pipeline/directory-extractors/index.js";
import { heroldExtractor } from "../../src/pipeline/directory-extractors/herold.js";
import { firmenabcExtractor } from "../../src/pipeline/directory-extractors/firmenabc.js";
import { wkoExtractor } from "../../src/pipeline/directory-extractors/wko.js";
import { facebookExtractor } from "../../src/pipeline/directory-extractors/facebook.js";
import { instagramExtractor } from "../../src/pipeline/directory-extractors/instagram.js";
import { falstaffExtractor } from "../../src/pipeline/directory-extractors/falstaff.js";
import { gaultmillauExtractor } from "../../src/pipeline/directory-extractors/gaultmillau.js";

const FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/directories",
);

function fixture(name: string): string {
  return readFileSync(resolve(FIXTURES, name), "utf8");
}

function run(
  extractor: { extract: (h: string, $: ReturnType<typeof load>) => string | null },
  filename: string,
): string | null {
  const html = fixture(filename);
  return extractor.extract(html, load(html));
}

describe("heroldExtractor", () => {
  it("extracts the data-testid website link and strips utm_source", () => {
    const url = run(heroldExtractor, "herold.html");
    expect(url).toBe("https://gasthaus-ochsen.at");
  });

  it("returns null when no website selector matches", () => {
    expect(run(heroldExtractor, "herold-empty.html")).toBeNull();
  });
});

describe("firmenabcExtractor", () => {
  it("extracts the .company-website link", () => {
    expect(run(firmenabcExtractor, "firmenabc.html")).toBe(
      "https://beispiel-firma.at",
    );
  });
});

describe("wkoExtractor", () => {
  it("extracts url from JSON-LD Organization", () => {
    expect(run(wkoExtractor, "wko.html")).toBe(
      "https://beispiel-handwerk.at",
    );
  });
});

describe("facebookExtractor", () => {
  it("decodes the aria-label website link", () => {
    // The first selector ($('a[aria-label*="Website"]')) grabs the
    // l.facebook.com link; firstPublicUrl then sees it's blacklisted
    // (facebook.com host) and tries the next candidate (data-key).
    const out = run(facebookExtractor, "facebook.html");
    expect(out).toBe("https://cafe-zentral.at");
  });

  it("returns null when all hits are blacklisted hosts", () => {
    expect(run(facebookExtractor, "facebook-blacklist.html")).toBeNull();
  });
});

describe("instagramExtractor", () => {
  it("decodes the l.instagram.com shim URL", () => {
    expect(run(instagramExtractor, "instagram.html")).toBe(
      "https://shop-example.at",
    );
  });
});

describe("falstaffExtractor", () => {
  it("extracts the .restaurant-info website link", () => {
    expect(run(falstaffExtractor, "falstaff.html")).toBe(
      "https://restaurant-beispiel.at",
    );
  });
});

describe("gaultmillauExtractor", () => {
  it("extracts the first http link inside .restaurant-details", () => {
    expect(run(gaultmillauExtractor, "gaultmillau.html")).toBe(
      "https://gourmet-wien.at",
    );
  });
});

describe("pickExtractor", () => {
  it("picks herold for herold.at URLs", () => {
    expect(pickExtractor("https://herold.at/xyz")?.id).toBe("herold");
    expect(pickExtractor("https://www.herold.at/xyz")?.id).toBe("herold");
  });

  it("picks wko only for firmen.wko.at subdomain", () => {
    expect(pickExtractor("https://firmen.wko.at/abc")?.id).toBe("wko");
    expect(pickExtractor("https://www.wko.at/abc")?.id).toBeUndefined();
  });

  it("returns null for unknown hosts", () => {
    expect(pickExtractor("https://unknown.example.com")).toBeNull();
  });

  it("returns null for malformed URLs", () => {
    expect(pickExtractor("not-a-url")).toBeNull();
  });
});

describe("EXTRACTORS registry", () => {
  it("has 7 extractors with unique ids", () => {
    expect(EXTRACTORS.length).toBe(7);
    const ids = EXTRACTORS.map((e) => e.id);
    expect(new Set(ids).size).toBe(7);
  });
});

describe("isBlacklistedHost", () => {
  it("flags directory hosts", () => {
    expect(isBlacklistedHost("https://facebook.com/x")).toBe(true);
    expect(isBlacklistedHost("https://www.instagram.com/x")).toBe(true);
    expect(isBlacklistedHost("https://firmen.wko.at/x")).toBe(true);
  });

  it("allows real business hosts", () => {
    expect(isBlacklistedHost("https://gasthaus-ochsen.at")).toBe(false);
  });

  it("flags malformed URLs as blacklisted", () => {
    expect(isBlacklistedHost("not-a-url")).toBe(true);
  });
});

describe("normalizeUrl", () => {
  it("strips trailing slash and utm params", () => {
    expect(normalizeUrl("https://x.at/?utm_source=foo")).toBe("https://x.at");
  });

  it("rejects non-http(s)", () => {
    expect(normalizeUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeUrl("mailto:a@b.c")).toBeNull();
  });

  it("returns null on empty/undefined", () => {
    expect(normalizeUrl(undefined)).toBeNull();
    expect(normalizeUrl("")).toBeNull();
    expect(normalizeUrl("   ")).toBeNull();
  });
});
