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
  type Interceptable,
} from "undici";
import { fetchUrl } from "../../src/lib/http-fetch.js";
import { resetEnvCache } from "../../src/lib/env.js";

// MockAgent routes global fetch() through an interceptor instead of the
// real network. Each test asserts explicit expectations; unused interceptors
// would otherwise linger across tests.
describe("fetchUrl", () => {
  let agent: MockAgent;
  const originalDispatcher = getGlobalDispatcher();

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_FETCH_RETRIES", "0");
    vi.stubEnv("AUDIT_FETCH_TIMEOUT_MS", "1000");
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

  function pool(origin: string): Interceptable {
    return agent.get(origin);
  }

  it("returns 200 with body on success", async () => {
    pool("https://example.at")
      .intercept({ path: "/", method: "GET" })
      .reply(200, "<html>hi</html>", {
        headers: { "content-type": "text/html" },
      });

    const res = await fetchUrl("https://example.at/");
    expect(res.status).toBe(200);
    expect(res.body).toContain("hi");
    expect(res.error).toBeNull();
  });

  it("classifies 404 as HTTP_4XX", async () => {
    pool("https://example.at")
      .intercept({ path: "/missing", method: "GET" })
      .reply(404, "not found");

    const res = await fetchUrl("https://example.at/missing");
    expect(res.status).toBe(404);
    expect(res.error).toBe("HTTP_4XX");
  });

  it("classifies 500 as HTTP_5XX (retries=0)", async () => {
    pool("https://example.at")
      .intercept({ path: "/boom", method: "GET" })
      .reply(500, "server error");

    const res = await fetchUrl("https://example.at/boom");
    expect(res.status).toBe(500);
    expect(res.error).toBe("HTTP_5XX");
  });

  it("retries on 429 and succeeds on second attempt", async () => {
    vi.stubEnv("AUDIT_FETCH_RETRIES", "1");
    resetEnvCache();

    pool("https://example.at")
      .intercept({ path: "/rate", method: "GET" })
      .reply(429, "rate-limited");
    pool("https://example.at")
      .intercept({ path: "/rate", method: "GET" })
      .reply(200, "ok");

    const res = await fetchUrl("https://example.at/rate", { retries: 1 });
    // Note: the helper applies a backoff sleep between attempts — test
    // inherits that wait but MockAgent handles the second interceptor fine.
    expect(res.status).toBe(200);
    expect(res.error).toBeNull();
  }, 10_000);

  it("classifies ENOTFOUND as DNS_FAIL", async () => {
    // MockAgent with disableNetConnect + no interceptor for this origin
    // raises UND_ERR_CONNECT_TIMEOUT or similar; we simulate DNS failure
    // by throwing a node-style error with code ENOTFOUND.
    pool("https://does-not-resolve.invalid")
      .intercept({ path: "/", method: "GET" })
      .replyWithError(
        Object.assign(new Error("getaddrinfo ENOTFOUND"), {
          code: "ENOTFOUND",
        }),
      );

    const res = await fetchUrl("https://does-not-resolve.invalid/");
    expect(res.status).toBe(0);
    expect(res.error).toBe("DNS_FAIL");
  });

  it("classifies CERT_HAS_EXPIRED as CERT_EXPIRED", async () => {
    pool("https://expired.example.at")
      .intercept({ path: "/", method: "GET" })
      .replyWithError(
        Object.assign(new Error("cert expired"), {
          code: "CERT_HAS_EXPIRED",
        }),
      );

    const res = await fetchUrl("https://expired.example.at/");
    expect(res.error).toBe("CERT_EXPIRED");
  });

  it("classifies ECONNREFUSED as CONNECTION_REFUSED", async () => {
    pool("https://refused.example.at")
      .intercept({ path: "/", method: "GET" })
      .replyWithError(
        Object.assign(new Error("refused"), { code: "ECONNREFUSED" }),
      );

    const res = await fetchUrl("https://refused.example.at/");
    expect(res.error).toBe("CONNECTION_REFUSED");
  });

  it("sets User-Agent and Accept-Language headers", async () => {
    // MockAgent's header matching is case-insensitive and requires the
    // interceptor to match; if it doesn't, undici throws UND_ERR_MOCK_NOT_MATCHED.
    // A successful reply is sufficient proof the headers went out correctly.
    pool("https://example.at")
      .intercept({
        path: "/",
        method: "GET",
        headers: {
          "user-agent": "test-agent/1.0",
          "accept-language": "de",
        },
      })
      .reply(200, "ok");

    const res = await fetchUrl("https://example.at/", {
      userAgent: "test-agent/1.0",
      acceptLanguage: "de",
    });
    expect(res.status).toBe(200);
    expect(res.error).toBeNull();
  });
});
