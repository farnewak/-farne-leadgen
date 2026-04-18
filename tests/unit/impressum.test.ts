import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  MockAgent,
  setGlobalDispatcher,
  getGlobalDispatcher,
} from "undici";
import {
  fetchAndParseImpressum,
  parseImpressumHtml,
  IMPRESSUM_PATHS,
} from "../../src/pipeline/impressum.js";
import { resetEnvCache } from "../../src/lib/env.js";

const FIXTURES = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/websites",
);

const fixture = (name: string): string =>
  readFileSync(resolve(FIXTURES, name), "utf8");

describe("parseImpressumHtml", () => {
  it("parses a complete Austrian Impressum", () => {
    const r = parseImpressumHtml(
      fixture("impressum-vollstaendig.html"),
      "https://example.at/impressum",
    );
    expect(r.present).toBe(true);
    expect(r.uid).toBe("ATU12345678");
    expect(r.companyName).toContain("Beispiel Handelsgesellschaft");
    expect(r.address).toContain("1030");
    expect(r.phone).toContain("+43");
    expect(r.email).toBe("office@beispiel-gmbh.at");
    expect(r.complete).toBe(true);
  });

  it("flags incomplete when required fields are missing", () => {
    const r = parseImpressumHtml(
      fixture("impressum-unvollstaendig.html"),
      "https://example.at/impressum",
    );
    expect(r.present).toBe(true);
    expect(r.complete).toBe(false);
    expect(r.uid).toBeNull();
    // Personal email — must be rejected by email filter
    expect(r.email).toBeNull();
  });

  it("retains the supplied URL", () => {
    const r = parseImpressumHtml("<html></html>", "https://x.at/impressum");
    expect(r.url).toBe("https://x.at/impressum");
  });
});

describe("IMPRESSUM_PATHS", () => {
  it("lists /impressum first", () => {
    expect(IMPRESSUM_PATHS[0]).toBe("/impressum");
  });

  it("includes /imprint, /legal, /kontakt, /about, /ueber-uns", () => {
    expect(IMPRESSUM_PATHS).toContain("/imprint");
    expect(IMPRESSUM_PATHS).toContain("/legal");
    expect(IMPRESSUM_PATHS).toContain("/kontakt");
    expect(IMPRESSUM_PATHS).toContain("/about");
    expect(IMPRESSUM_PATHS).toContain("/ueber-uns");
  });
});

describe("fetchAndParseImpressum", () => {
  let agent: MockAgent;
  const originalDispatcher = getGlobalDispatcher();

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_FETCH_RETRIES", "0");
    vi.stubEnv("AUDIT_FETCH_TIMEOUT_MS", "2000");
    resetEnvCache();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
    setGlobalDispatcher(originalDispatcher);
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it("follows footer /impressum link and parses the page", async () => {
    agent
      .get("https://example.at")
      .intercept({ path: "/", method: "GET" })
      .reply(
        200,
        `<html><body><footer><a href="/impressum">Impressum</a></footer></body></html>`,
      );
    agent
      .get("https://example.at")
      .intercept({ path: "/impressum", method: "GET" })
      .reply(200, fixture("impressum-vollstaendig.html"));

    const r = await fetchAndParseImpressum("https://example.at");
    expect(r.present).toBe(true);
    expect(r.uid).toBe("ATU12345678");
    expect(r.complete).toBe(true);
  });

  it("falls back to conventional path when no footer link exists", async () => {
    agent
      .get("https://example.at")
      .intercept({ path: "/", method: "GET" })
      .reply(200, `<html><body><h1>home</h1></body></html>`);
    agent
      .get("https://example.at")
      .intercept({ path: "/impressum", method: "GET" })
      .reply(200, fixture("impressum-vollstaendig.html"));

    const r = await fetchAndParseImpressum("https://example.at");
    expect(r.present).toBe(true);
    expect(r.uid).toBe("ATU12345678");
  });

  it("returns present=false when no candidate path responds with 200", async () => {
    agent
      .get("https://example.at")
      .intercept({ path: "/", method: "GET" })
      .reply(200, `<html><body></body></html>`);
    for (const p of IMPRESSUM_PATHS) {
      agent
        .get("https://example.at")
        .intercept({ path: p, method: "GET" })
        .reply(404, "not found");
    }

    const r = await fetchAndParseImpressum("https://example.at");
    expect(r.present).toBe(false);
    expect(r.url).toBeNull();
  });
});
