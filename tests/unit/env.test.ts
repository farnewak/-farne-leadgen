import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { loadEnv, resetEnvCache, googleApiKey } from "../../src/lib/env.js";

describe("loadEnv", () => {
  // Each test starts with a fully wiped cache + every relevant var unstubbed.
  // Using vi.unstubAllEnvs in afterEach keeps tests isolated — process.env is
  // a single shared object across the whole suite otherwise.
  // The project's real .env may define GOOGLE_API_KEY etc. — those get loaded
  // into process.env before tests start. vi.unstubAllEnvs() only clears stubs
  // set via vi.stubEnv; it does NOT revert dotenv-injected values. Explicit
  // stubEnv("", ""-treated-as-unset) in beforeEach isolates each test.
  const GOOGLE_VARS = [
    "GOOGLE_API_KEY",
    "GOOGLE_CSE_ID",
    "GOOGLE_MAPS_API_KEY",
    "PAGESPEED_API_KEY",
    "ANTHROPIC_API_KEY",
  ] as const;

  beforeEach(() => {
    resetEnvCache();
    vi.unstubAllEnvs();
    for (const k of GOOGLE_VARS) vi.stubEnv(k, "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it("returns defaults when env is empty", () => {
    const env = loadEnv();
    expect(env.DATABASE_URL).toBe("file:./runs/leadgen.db");
    expect(env.LEADGEN_CITY).toBe("Vienna");
    expect(env.LEADGEN_LOG_LEVEL).toBe("info");
    expect(env.OVERPASS_MAX_REQUESTS_PER_RUN).toBe(40);
    expect(env.AUDIT_CONCURRENCY).toBe(10);
    expect(env.AUDIT_STATIC_TTL_DAYS).toBe(30);
    expect(env.AUDIT_PSI_TTL_DAYS).toBe(14);
    expect(env.AUDIT_RESPECT_ROBOTS_TXT).toBe(true);
    expect(env.DNS_PROBE_ENABLED).toBe(true);
    expect(env.CSE_DISCOVERY_ENABLED).toBe(false);
  });

  it("z.coerce.number() parses AUDIT_CONCURRENCY='5' to 5", () => {
    vi.stubEnv("AUDIT_CONCURRENCY", "5");
    expect(loadEnv().AUDIT_CONCURRENCY).toBe(5);
  });

  it("boolEnv: 'false' -> false", () => {
    vi.stubEnv("AUDIT_RESPECT_ROBOTS_TXT", "false");
    expect(loadEnv().AUDIT_RESPECT_ROBOTS_TXT).toBe(false);
  });

  it("boolEnv: '0' -> false", () => {
    vi.stubEnv("AUDIT_RESPECT_ROBOTS_TXT", "0");
    expect(loadEnv().AUDIT_RESPECT_ROBOTS_TXT).toBe(false);
  });

  it("boolEnv: 'true' -> true", () => {
    vi.stubEnv("CSE_DISCOVERY_ENABLED", "true");
    expect(loadEnv().CSE_DISCOVERY_ENABLED).toBe(true);
  });

  it("boolEnv: '1' -> true", () => {
    vi.stubEnv("CSE_DISCOVERY_ENABLED", "1");
    expect(loadEnv().CSE_DISCOVERY_ENABLED).toBe(true);
  });

  it("boolEnv rejects 'xyz'", () => {
    vi.stubEnv("AUDIT_RESPECT_ROBOTS_TXT", "xyz");
    expect(() => loadEnv()).toThrow(/invalid env/);
  });

  it("googleApiKey() prefers GOOGLE_API_KEY", () => {
    vi.stubEnv("GOOGLE_API_KEY", "primary");
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "legacy-maps");
    vi.stubEnv("PAGESPEED_API_KEY", "legacy-psi");
    expect(googleApiKey()).toBe("primary");
  });

  it("googleApiKey() falls back to GOOGLE_MAPS_API_KEY", () => {
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "legacy-maps");
    expect(googleApiKey()).toBe("legacy-maps");
  });

  it("googleApiKey() falls back to PAGESPEED_API_KEY", () => {
    vi.stubEnv("PAGESPEED_API_KEY", "legacy-psi");
    expect(googleApiKey()).toBe("legacy-psi");
  });

  it("googleApiKey() returns undefined when no key is set", () => {
    expect(googleApiKey()).toBeUndefined();
  });

  it("loadEnv() is cached - second call does not re-parse", () => {
    const first = loadEnv();
    vi.stubEnv("LEADGEN_CITY", "Salzburg");
    // No resetEnvCache() → cached value should still be served
    const second = loadEnv();
    expect(second).toBe(first);
    expect(second.LEADGEN_CITY).toBe("Vienna");
  });

  it("resetEnvCache() forces re-parse", () => {
    loadEnv();
    vi.stubEnv("LEADGEN_CITY", "Salzburg");
    resetEnvCache();
    expect(loadEnv().LEADGEN_CITY).toBe("Salzburg");
  });
});
