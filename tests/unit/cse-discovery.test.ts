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
import {
  discoverViaCse,
  resetCseState,
} from "../../src/pipeline/cse-discovery.js";
import { resetEnvCache } from "../../src/lib/env.js";
import { resetCandidateValidatorCache } from "../../src/pipeline/candidate-validator.js";
import type { PlaceCandidate } from "../../src/models/types.js";

const CANDIDATE: PlaceCandidate = {
  placeId: "osm:node:1",
  name: "Gasthaus Ochsen",
  address: "Hauptstr. 1, 1030 Wien",
  plz: "1030",
  district: "03",
  types: ["amenity=restaurant"],
  primaryType: "restaurant",
  website: null,
  phone: null,
  lat: 48.2,
  lng: 16.4,
};

describe("discoverViaCse", () => {
  let agent: MockAgent;
  const originalDispatcher = getGlobalDispatcher();

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("CSE_DISCOVERY_ENABLED", "true");
    vi.stubEnv("GOOGLE_API_KEY", "test-key");
    vi.stubEnv("GOOGLE_CSE_ID", "test-cx");
    vi.stubEnv("AUDIT_FETCH_RETRIES", "0");
    vi.stubEnv("AUDIT_FETCH_TIMEOUT_MS", "1000");
    resetEnvCache();
    resetCseState();
    resetCandidateValidatorCache();
    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
    setGlobalDispatcher(originalDispatcher);
    vi.unstubAllEnvs();
    resetEnvCache();
    resetCseState();
  });

  it("returns null when CSE is disabled", async () => {
    vi.stubEnv("CSE_DISCOVERY_ENABLED", "false");
    resetEnvCache();
    const result = await discoverViaCse(CANDIDATE);
    expect(result).toBeNull();
  });

  it("returns null and logs warn on 429 (quota)", async () => {
    agent
      .get("https://www.googleapis.com")
      .intercept({ path: /\/customsearch\/v1\?.*/, method: "GET" })
      .reply(429, '{"error":"rate"}');

    const result = await discoverViaCse(CANDIDATE);
    expect(result).toBeNull();
  });

  it("follows extractor flow and returns validated URL on hit", async () => {
    // Query 1 returns a herold link. The herold page contains the website.
    // The website page contains enough text to pass validatesCandidate.
    const cseBody = JSON.stringify({
      items: [{ link: "https://herold.at/biz/gasthaus-ochsen" }],
    });
    agent
      .get("https://www.googleapis.com")
      .intercept({ path: /\/customsearch\/v1\?.*/, method: "GET" })
      .reply(200, cseBody);

    agent
      .get("https://herold.at")
      .intercept({ path: "/biz/gasthaus-ochsen", method: "GET" })
      .reply(
        200,
        `<html><body>
          <a data-testid="website-link" href="https://gasthaus-ochsen.at">site</a>
        </body></html>`,
      );

    agent
      .get("https://gasthaus-ochsen.at")
      .intercept({ path: "/", method: "GET" })
      .reply(
        200,
        `<html><body>Willkommen im Gasthaus Ochsen, 1030 Wien</body></html>`,
      );

    const result = await discoverViaCse(CANDIDATE);
    expect(result).not.toBeNull();
    expect(result?.discoveredUrl).toBe("https://gasthaus-ochsen.at");
    expect(result?.via).toBe("herold");
    expect(result?.method).toBe("cse");
  });

  it("returns null when no CSE items match an extractor", async () => {
    const cseBody = JSON.stringify({
      items: [{ link: "https://random-blog.example.com/post" }],
    });
    agent
      .get("https://www.googleapis.com")
      .intercept({ path: /\/customsearch\/v1\?.*/, method: "GET" })
      .reply(200, cseBody)
      .times(3);

    const result = await discoverViaCse(CANDIDATE);
    expect(result).toBeNull();
  });
});
