import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  MockAgent,
  setGlobalDispatcher,
  getGlobalDispatcher,
} from "undici";

// Mock SSL + PSI so both candidates hit identical transport/psi baseline;
// only the HTML body differentiates their scores.
vi.mock("../../src/pipeline/ssl-check.js", () => ({
  checkTransport: vi.fn(async (_host: string) => ({
    sslValid: false,
    sslExpiresAt: null,
    httpToHttpsRedirect: false,
    fetchError: "CERT_INVALID" as const,
  })),
}));

vi.mock("../../src/pipeline/psi.js", () => ({
  runPsiMobile: vi.fn(async (_url: string) => ({
    performance: null,
    seo: null,
    accessibility: null,
    bestPractices: null,
    fetchedAt: new Date("2026-04-20T12:00:00.000Z"),
    error: "CLIENT_ERROR" as const,
  })),
}));

import { runAudit } from "../../src/pipeline/audit.js";
import { resetEnvCache } from "../../src/lib/env.js";
import { __resetDbClientForTests } from "../../src/db/client.js";
import { resetRobotsCache } from "../../src/pipeline/robots.js";
import type { PlaceCandidate } from "../../src/models/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP_DB = resolve(HERE, "../tmp/url-dedupe-pipeline.db");
const TMP_LOG_DIR = resolve(HERE, "../tmp/url-dedupe-pipeline-logs");
const FIXED_NOW = new Date("2026-04-20T12:00:00.000Z");
const EARLIER = new Date("2026-04-18T12:00:00.000Z");
const LATER = new Date("2026-04-19T12:00:00.000Z");

function freshDb(): void {
  try {
    rmSync(TMP_DB, { force: true });
    rmSync(`${TMP_DB}-wal`, { force: true });
    rmSync(`${TMP_DB}-shm`, { force: true });
  } catch {
    // tmp may not exist
  }
  mkdirSync(dirname(TMP_DB), { recursive: true });
  const sql = new Database(TMP_DB);
  const migrations = [
    "0000_init.sql",
    "0001_audit_results.sql",
    "0002_intent_tier.sql",
    "0003_lead_outcomes.sql",
    "0004_chain_apex_dedupe.sql",
    "0005_last_modified_signal.sql",
    "0006_has_structured_data.sql",
  ].map((f) =>
    readFileSync(resolve(HERE, "../../src/db/migrations/sqlite", f), "utf8"),
  );
  for (const m of migrations) {
    const parts = m.split("--> statement-breakpoint");
    for (const p of parts) {
      const trimmed = p.trim();
      if (trimmed) sql.exec(trimmed);
    }
  }
  sql.close();
}

// Partial-impressum HTML used by both R7a and R7b; R7b gets a viewport
// meta on its home page so its Tier-A score drops NO_MOBILE_VIEWPORT=3.
const HOME_R7A =
  "<!doctype html><html><head><title>Menu</title></head>" +
  "<body><h1>Menu Kleinmeister</h1>" +
  "<p>Wipplingerstraße 14, 1010 Wien</p></body></html>";
const HOME_R7B =
  '<!doctype html><html><head><meta name="viewport" content="width=device-width">' +
  "<title>Menu</title></head>" +
  "<body><h1>Menu Kleinmeister</h1>" +
  "<p>Wipplingerstraße 14, 1010 Wien</p></body></html>";
const IMPRESSUM_PARTIAL =
  "<!doctype html><html><body>" +
  "<h1>Impressum</h1>" +
  "<p>Kleinmeister Café GmbH</p>" +
  "<p>Wipplingerstraße 14, 1010 Wien</p>" +
  "</body></html>";

describe("runAudit url-dedupe (R7a/R7b)", () => {
  let agent: MockAgent;
  const originalDispatcher = getGlobalDispatcher();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(FIXED_NOW);

    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", `file:${TMP_DB}`);
    vi.stubEnv("AUDIT_FETCH_RETRIES", "0");
    vi.stubEnv("AUDIT_FETCH_TIMEOUT_MS", "2000");
    vi.stubEnv("AUDIT_RESPECT_ROBOTS_TXT", "false");
    vi.stubEnv("AUDIT_CONCURRENCY", "5");
    vi.stubEnv("AUDIT_MIN_DELAY_PER_HOST_MS", "0");
    vi.stubEnv("DNS_PROBE_ENABLED", "false");
    vi.stubEnv("CSE_DISCOVERY_ENABLED", "false");
    vi.stubEnv("B3_ENRICHMENT_ENABLED", "false");
    vi.stubEnv("IMPRESSUM_SCRAPER_ENABLED", "false");
    vi.stubEnv("AUDIT_STATIC_TTL_DAYS", "30");
    vi.stubEnv("AUDIT_PSI_TTL_DAYS", "14");
    resetEnvCache();
    __resetDbClientForTests();
    resetRobotsCache();
    freshDb();

    try {
      rmSync(TMP_LOG_DIR, { recursive: true, force: true });
    } catch {
      // best-effort
    }

    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);

    // R7a: no-www, plain /menu.
    agent
      .get("https://kleinmeister-cafe.at")
      .intercept({ path: "/menu", method: "GET" })
      .reply(200, HOME_R7A)
      .persist();
    for (const p of [
      "/impressum",
      "/imprint",
      "/legal",
      "/kontakt",
      "/about",
      "/ueber-uns",
    ]) {
      agent
        .get("https://kleinmeister-cafe.at")
        .intercept({ path: p, method: "GET" })
        .reply(p === "/impressum" ? 200 : 404, p === "/impressum" ? IMPRESSUM_PARTIAL : "")
        .persist();
    }

    // R7b: www-prefixed, /menu/ with utm param. Body carries a viewport
    // meta so its Tier-A score comes in lower than R7a's.
    agent
      .get("https://www.kleinmeister-cafe.at")
      .intercept({ path: "/menu/?utm_source=flyer", method: "GET" })
      .reply(200, HOME_R7B)
      .persist();
    for (const p of [
      "/impressum",
      "/imprint",
      "/legal",
      "/kontakt",
      "/about",
      "/ueber-uns",
    ]) {
      agent
        .get("https://www.kleinmeister-cafe.at")
        .intercept({ path: p, method: "GET" })
        .reply(p === "/impressum" ? 200 : 404, p === "/impressum" ? IMPRESSUM_PARTIAL : "")
        .persist();
    }
  });

  afterEach(async () => {
    await agent.close();
    setGlobalDispatcher(originalDispatcher);
    vi.unstubAllEnvs();
    vi.useRealTimers();
    resetEnvCache();
    __resetDbClientForTests();
    try {
      rmSync(TMP_LOG_DIR, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("collapses two candidates sharing a normalized URL: R7a kept, R7b logged", async () => {
    const r7a: PlaceCandidate = {
      placeId: "osm:node:100000009",
      name: "Café Kleinmeister Menu (A)",
      address: "Wipplingerstraße 14, 1010 Wien",
      plz: "1010",
      district: "Innere Stadt",
      types: ["amenity=cafe"],
      primaryType: "cafe",
      website: "https://kleinmeister-cafe.at/menu",
      phone: null,
      lat: 48.2105,
      lng: 16.3695,
    };
    const r7b: PlaceCandidate = {
      placeId: "osm:node:100000010",
      name: "Café Kleinmeister Menu (B)",
      address: "Wipplingerstraße 14, 1010 Wien",
      plz: "1010",
      district: "Innere Stadt",
      types: ["amenity=cafe"],
      primaryType: "cafe",
      website: "https://www.kleinmeister-cafe.at/menu/?utm_source=flyer",
      phone: null,
      lat: 48.2105,
      lng: 16.3695,
    };

    // Single pipeline pass. Both candidates share apex kleinmeister-cafe.at,
    // so the chain-apex dedupe would normally collapse them into one
    // canonical row — short-circuit that stage by injecting a null apex
    // auditor so url-dedupe sees the full pair. Both URLs normalize to
    // the same key; url-dedupe keeps the higher-score row (R7a, thanks
    // to its missing viewport meta) and logs the other to
    // duplicate_urls.csv.
    vi.setSystemTime(FIXED_NOW);
    await runAudit({
      limit: 10,
      discover: async () => [r7a, r7b],
      auditApex: async () => null,
      logDir: TMP_LOG_DIR,
    });

    const sql = new Database(TMP_DB, { readonly: true });
    const rows = sql
      .prepare("SELECT place_id, score, discovered_url FROM audit_results ORDER BY place_id")
      .all() as Array<{ place_id: string; score: number | null; discovered_url: string | null }>;
    sql.close();

    // Exactly one of the two survives in the DB; the other landed in the log.
    expect(rows).toHaveLength(1);
    const keeper = rows[0]!;
    expect(keeper.place_id).toBe("osm:node:100000009");
    expect(keeper.discovered_url).toBe("https://kleinmeister-cafe.at/menu");

    const csvPath = resolve(TMP_LOG_DIR, "duplicate_urls.csv");
    const csv = readFileSync(csvPath, "utf-8");
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(
      "kept_place_id,dropped_place_id,normalized_url,kept_score,dropped_score,duplicate_reason,filtered_at",
    );
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("osm:node:100000009");
    expect(lines[1]).toContain("osm:node:100000010");
    expect(lines[1]).toContain("https://kleinmeister-cafe.at/menu");
    expect(lines[1]).toContain("same_normalized_url");
  });
});
