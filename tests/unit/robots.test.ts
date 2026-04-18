import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  MockAgent,
  setGlobalDispatcher,
  getGlobalDispatcher,
} from "undici";
import { getRobotsRules, resetRobotsCache } from "../../src/pipeline/robots.js";
import { resetEnvCache } from "../../src/lib/env.js";

describe("getRobotsRules", () => {
  let agent: MockAgent;
  const original = getGlobalDispatcher();

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_FETCH_RETRIES", "0");
    vi.stubEnv("AUDIT_FETCH_TIMEOUT_MS", "2000");
    resetEnvCache();
    resetRobotsCache();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
    setGlobalDispatcher(original);
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it("empty body → allow-all, 0ms delay", async () => {
    agent
      .get("https://example.at")
      .intercept({ path: "/robots.txt", method: "GET" })
      .reply(200, "");
    const r = await getRobotsRules("https://example.at");
    expect(r.allowed("/anything")).toBe(true);
    expect(r.crawlDelayMs).toBe(0);
  });

  it("longest-prefix match: Allow wins inside a Disallowed prefix", async () => {
    agent
      .get("https://example.at")
      .intercept({ path: "/robots.txt", method: "GET" })
      .reply(
        200,
        "User-agent: *\nDisallow: /private\nAllow: /private/public",
      );
    const r = await getRobotsRules("https://example.at");
    expect(r.allowed("/private/x")).toBe(false);
    expect(r.allowed("/private/public/x")).toBe(true);
    expect(r.allowed("/")).toBe(true);
  });

  it("non-star UA block is ignored", async () => {
    agent
      .get("https://example.at")
      .intercept({ path: "/robots.txt", method: "GET" })
      .reply(
        200,
        "User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nAllow: /\n",
      );
    const r = await getRobotsRules("https://example.at");
    expect(r.allowed("/x")).toBe(true);
  });

  it("Crawl-delay: 5 → 5000ms", async () => {
    agent
      .get("https://example.at")
      .intercept({ path: "/robots.txt", method: "GET" })
      .reply(200, "User-agent: *\nCrawl-delay: 5\n");
    const r = await getRobotsRules("https://example.at");
    expect(r.crawlDelayMs).toBe(5000);
  });

  it("Crawl-delay: 0.5 → 500ms", async () => {
    agent
      .get("https://example.at")
      .intercept({ path: "/robots.txt", method: "GET" })
      .reply(200, "User-agent: *\nCrawl-delay: 0.5\n");
    const r = await getRobotsRules("https://example.at");
    expect(r.crawlDelayMs).toBe(500);
  });

  it("Crawl-delay: bogus → 0", async () => {
    agent
      .get("https://example.at")
      .intercept({ path: "/robots.txt", method: "GET" })
      .reply(200, "User-agent: *\nCrawl-delay: nonsense\n");
    const r = await getRobotsRules("https://example.at");
    expect(r.crawlDelayMs).toBe(0);
  });

  it("404 → allow-all, 0ms", async () => {
    agent
      .get("https://example.at")
      .intercept({ path: "/robots.txt", method: "GET" })
      .reply(404, "not found");
    const r = await getRobotsRules("https://example.at");
    expect(r.allowed("/anything")).toBe(true);
    expect(r.crawlDelayMs).toBe(0);
  });

  it("caches by origin — second call issues no new request", async () => {
    agent
      .get("https://example.at")
      .intercept({ path: "/robots.txt", method: "GET" })
      .reply(200, "User-agent: *\nDisallow: /x\n");
    const r1 = await getRobotsRules("https://example.at");
    // If the cache weren't holding the promise, this would throw
    // "No interceptors defined" since we only registered one intercept.
    const r2 = await getRobotsRules("https://example.at");
    expect(r1).toBe(r2);
  });

  it("cache distinguishes http vs https", async () => {
    agent
      .get("http://example.at")
      .intercept({ path: "/robots.txt", method: "GET" })
      .reply(200, "User-agent: *\nDisallow: /\n");
    agent
      .get("https://example.at")
      .intercept({ path: "/robots.txt", method: "GET" })
      .reply(200, "User-agent: *\nAllow: /\n");
    const http = await getRobotsRules("http://example.at");
    const https = await getRobotsRules("https://example.at");
    expect(http.allowed("/x")).toBe(false);
    expect(https.allowed("/x")).toBe(true);
  });
});
