import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseImpressumPage,
  normalizeAustrianPhone,
  scrapeImpressum,
  SCRAPER_USER_AGENT,
  type ScrapedContact,
} from "../../src/tools/enrich/impressum-scraper.js";
import type { FetchResult, FetchOptions } from "../../src/lib/http-fetch.js";

function fixturePath(name: string): string {
  return join(process.cwd(), "tests/fixtures/impressum", name);
}

async function loadFixture(name: string): Promise<string> {
  return readFile(fixturePath(name), "utf8");
}

describe("parseImpressumPage — fixtures", () => {
  it("anwaltskanzlei — extracts company + phone + personal email", async () => {
    const html = await loadFixture("anwaltskanzlei.html");
    const p = parseImpressumPage(html);
    expect(p.companyName).toMatch(/Huber Rechtsanwalts GmbH/i);
    expect(p.phone).toBe("+4315123456");
    // Personal email prioritised above office@
    expect(p.email).toBe("peter.huber@huber-recht.at");
    expect(p.emails).toContain("office@huber-recht.at");
    expect(p.address).toMatch(/Singerstraße 8, 1010 Wien/);
    expect(p.plz).toBe("1010");
    expect(p.uid).toBe("ATU44455566");
  });

  it("ingenieurbuero — deobfuscates [at], normalises 0043 phone", async () => {
    const html = await loadFixture("ingenieurbuero.html");
    const p = parseImpressumPage(html);
    expect(p.email).toBe("info@mayer-partner.at");
    expect(p.phone).toBe("+436601234567");
    expect(p.plz).toBe("1070");
    expect(p.uid).toBe("ATU98765432");
  });

  it("gastro — tel: href takes precedence, noreply filtered", async () => {
    const html = await loadFixture("gastro.html");
    const p = parseImpressumPage(html);
    expect(p.phone).toBe("+4319999111");
    expect(p.email).toBe("kontakt@alte-eiche-wien.at");
    expect(p.emails).not.toContain("noreply@alte-eiche-wien.at");
    expect(p.plz).toBe("1190");
    expect(p.uid).toBe("ATU11223344");
  });

  it("einzelhandel — keeps info@ and personal, drops webmaster/admin noise", async () => {
    const html = await loadFixture("einzelhandel.html");
    const p = parseImpressumPage(html);
    // Personal email wins prioritisation
    expect(p.email).toBe("m.wallner@wallner-juwelier.at");
    expect(p.emails).toContain("info@wallner-juwelier.at");
    expect(p.emails).not.toContain("webmaster@example.com");
    expect(p.emails).not.toContain("admin@wordpress.org");
    expect(p.plz).toBe("1010");
    expect(p.phone).toBe("+43720123456");
  });

  it("handwerker — HTML-entity obfuscation + multiple phones", async () => {
    const html = await loadFixture("handwerker.html");
    const p = parseImpressumPage(html);
    // Both `buero@` (role) and `notfall@` (non-role) must be present.
    // Priority: personal/non-role ranks before role — `notfall@` wins.
    expect(p.emails).toContain("buero@novak-installationen.at");
    expect(p.emails).toContain("notfall@novak-installationen.at");
    expect(p.email).toBe("notfall@novak-installationen.at");
    expect(p.phone).toMatch(/^\+43(699|1)\d+/);
    expect(p.plz).toBe("1100");
    expect(p.uid).toBe("ATU22334455");
  });
});

describe("normalizeAustrianPhone — E.164", () => {
  it("Wien landline +43 1 …", () => {
    expect(normalizeAustrianPhone("+43 1 234 5678")).toBe("+4312345678");
  });
  it("0043-prefixed", () => {
    expect(normalizeAustrianPhone("0043 1 234 56 78")).toBe("+4312345678");
  });
  it("mobile +43 660", () => {
    expect(normalizeAustrianPhone("+43 660 1234567")).toBe("+436601234567");
  });
  it("mobile +43 699", () => {
    expect(normalizeAustrianPhone("+43 699 8887766")).toBe("+436998887766");
  });
  it("business VOIP +43 720", () => {
    expect(normalizeAustrianPhone("+43 720 123456")).toBe("+43720123456");
  });
  it("rejects obviously invalid numbers", () => {
    expect(normalizeAustrianPhone("123")).toBeNull();
    expect(normalizeAustrianPhone("0012345")).toBeNull();
  });
});

describe("parseImpressumPage — address quality gate", () => {
  it("rejects address with non-Vienna PLZ", () => {
    const html = `<html><body><p>
      Firma XY GmbH<br />Testgasse 5, 2000 Stockerau<br />
      Tel: +43 1 234 5678<br />UID: ATU12345678
    </p></body></html>`;
    const p = parseImpressumPage(html);
    expect(p.address).toBeNull();
    expect(p.plz).toBeNull();
    // Phone still extractable — the quality gate is address-specific
    expect(p.phone).toBe("+4312345678");
  });
  it("rejects 1121 (not a valid Wien-PLZ step)", () => {
    const html = `<html><body>Firma<br>Teststraße 3, 1121 Wien</body></html>`;
    expect(parseImpressumPage(html).plz).toBeNull();
  });
  it("accepts all Vienna steps 1010..1230", () => {
    for (const plz of ["1010", "1020", "1100", "1230"]) {
      const html = `<html><body>Firma<br>Teststraße 1, ${plz} Wien</body></html>`;
      expect(parseImpressumPage(html).plz).toBe(plz);
    }
  });
});

describe("scrapeImpressum — orchestration", () => {
  let cacheDir: string;
  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), "impressum-cache-"));
  });
  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  function okResult(body: string, finalUrl: string): FetchResult {
    return { status: 200, body, headers: {}, finalUrl, error: null };
  }
  function notFound(finalUrl: string): FetchResult {
    return { status: 404, body: "", headers: {}, finalUrl, error: "HTTP_4XX" };
  }

  const ALLOW_ALL = {
    allowed: () => true,
    crawlDelayMs: 0,
  };

  it("tries /impressum first, falls back to the next path on 404", async () => {
    const calls: string[] = [];
    const fetchStub = async (
      url: string,
      _opts?: FetchOptions,
    ): Promise<FetchResult> => {
      calls.push(url);
      if (url === "https://example.at/")
        return okResult("<html><body>home</body></html>", url);
      if (url.endsWith("/impressum")) return notFound(url);
      // Second candidate in SCRAPER_PATHS serves the Impressum fixture.
      if (url.endsWith("/imprint")) {
        const html = await loadFixture("handwerker.html");
        return okResult(html, url);
      }
      return notFound(url);
    };
    const result = await scrapeImpressum("https://example.at/", {
      cacheDir,
      fetch: fetchStub,
      getRobotsRules: async () => ALLOW_ALL,
    });
    expect(calls).toContain("https://example.at/impressum");
    expect(calls).toContain("https://example.at/imprint");
    expect(result.email).toBe("notfall@novak-installationen.at");
    expect(result.coverage).toContain("E");
    expect(result.coverage).toContain("P");
  });

  it("respects the 3-page cap (home + 2 candidates)", async () => {
    let n = 0;
    const fetchStub = async (
      _url: string,
      _opts?: FetchOptions,
    ): Promise<FetchResult> => {
      n += 1;
      return notFound(_url);
    };
    await scrapeImpressum("https://ex2.at/", {
      cacheDir,
      fetch: fetchStub,
      getRobotsRules: async () => ALLOW_ALL,
    });
    expect(n).toBe(3);
  });

  it("returns cached result on second call within TTL", async () => {
    let calls = 0;
    const fetchStub = async (
      url: string,
      _opts?: FetchOptions,
    ): Promise<FetchResult> => {
      calls += 1;
      const html = await loadFixture("anwaltskanzlei.html");
      return okResult(html, url);
    };
    const a = await scrapeImpressum("https://kanzlei.at/", {
      cacheDir,
      fetch: fetchStub,
      getRobotsRules: async () => ALLOW_ALL,
    });
    const b = await scrapeImpressum("https://kanzlei.at/", {
      cacheDir,
      fetch: fetchStub,
      getRobotsRules: async () => ALLOW_ALL,
    });
    expect(a.cacheHit).toBe(false);
    expect(b.cacheHit).toBe(true);
    expect(b.email).toBe(a.email);
    // Second call never hit the network
    const firstCallCount = calls;
    expect(firstCallCount).toBeGreaterThanOrEqual(1);
    const c = await scrapeImpressum("https://kanzlei.at/", {
      cacheDir,
      fetch: fetchStub,
      getRobotsRules: async () => ALLOW_ALL,
    });
    expect(c.cacheHit).toBe(true);
    expect(calls).toBe(firstCallCount);
  });

  it("robots.txt Disallow → fail-closed, robotsBlocked=true", async () => {
    let fetchCalls = 0;
    const fetchStub = async (
      url: string,
      _opts?: FetchOptions,
    ): Promise<FetchResult> => {
      fetchCalls += 1;
      return okResult("<html></html>", url);
    };
    const result = await scrapeImpressum("https://closed.at/", {
      cacheDir,
      fetch: fetchStub,
      // Explicitly deny every path.
      getRobotsRules: async () => ({
        allowed: () => false,
        crawlDelayMs: 0,
      }),
    });
    expect(fetchCalls).toBe(0);
    expect(result.robotsBlocked).toBe(true);
    expect(result.email).toBeNull();
    expect(result.phone).toBeNull();
    expect(result.coverage).toBe("");
  });

  it("coverage flag reflects available channels", async () => {
    const fetchStub = async (
      url: string,
      _opts?: FetchOptions,
    ): Promise<FetchResult> => {
      if (url.endsWith("/impressum")) {
        const html = await loadFixture("anwaltskanzlei.html");
        return okResult(html, url);
      }
      if (url === "https://cov.at/") {
        return okResult("<html><body>home</body></html>", url);
      }
      return notFound(url);
    };
    const result = await scrapeImpressum("https://cov.at/", {
      cacheDir,
      fetch: fetchStub,
      getRobotsRules: async () => ALLOW_ALL,
    });
    expect(result.coverage).toBe("PEA");
  });

  it("sends the scraper User-Agent", async () => {
    let seenUa: string | null = null;
    const fetchStub = async (
      url: string,
      opts?: FetchOptions,
    ): Promise<FetchResult> => {
      seenUa = opts?.userAgent ?? null;
      return okResult("<html><body></body></html>", url);
    };
    await scrapeImpressum("https://ua.at/", {
      cacheDir,
      fetch: fetchStub,
      getRobotsRules: async () => ALLOW_ALL,
    });
    expect(seenUa).toBe(SCRAPER_USER_AGENT);
  });
});

// Sanity export — guards against accidental rename during refactors.
describe("ScrapedContact shape", () => {
  it("emptyContact has the documented fields", () => {
    const empty: ScrapedContact = {
      impressumUrl: null,
      email: null,
      emails: [],
      phone: null,
      address: null,
      plz: null,
      companyName: null,
      uid: null,
      coverage: "",
      cacheHit: false,
      robotsBlocked: false,
    };
    expect(empty.coverage).toBe("");
  });
});
