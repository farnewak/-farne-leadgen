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
import { runAudit } from "../../src/pipeline/audit.js";
import { resetEnvCache } from "../../src/lib/env.js";
import { __resetDbClientForTests } from "../../src/db/client.js";
import { resetRobotsCache } from "../../src/pipeline/robots.js";
import type { PlaceCandidate } from "../../src/models/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP_DB = resolve(HERE, "../tmp/audit-pipeline.db");

function candidate(
  overrides: Partial<PlaceCandidate> & { placeId: string; name: string },
): PlaceCandidate {
  return {
    address: null,
    plz: null,
    district: null,
    types: [],
    primaryType: null,
    website: null,
    phone: null,
    lat: 48.2,
    lng: 16.37,
    ...overrides,
  };
}

function freshDb(): void {
  try {
    rmSync(TMP_DB, { force: true });
    rmSync(`${TMP_DB}-wal`, { force: true });
    rmSync(`${TMP_DB}-shm`, { force: true });
  } catch {
    // tmp file might not exist yet — ignore
  }
  mkdirSync(dirname(TMP_DB), { recursive: true });
  const sql = new Database(TMP_DB);
  // Apply both migrations inline — simpler than drizzle's migrator API for
  // a single-test fixture setup.
  const migrations = [
    "0000_init.sql",
    "0001_audit_results.sql",
    "0002_intent_tier.sql",
    "0003_lead_outcomes.sql",
    "0004_chain_apex_dedupe.sql",
  ].map((f) =>
    readFileSync(resolve(HERE, "../../src/db/migrations/sqlite", f), "utf8"),
  );
  for (const m of migrations) {
    // drizzle emits "statement-breakpoint" comments; split and exec each stmt.
    const parts = m.split("--> statement-breakpoint");
    for (const p of parts) {
      const trimmed = p.trim();
      if (trimmed) sql.exec(trimmed);
    }
  }
  sql.close();
}

describe("runAudit integration", () => {
  let agent: MockAgent;
  const originalDispatcher = getGlobalDispatcher();

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", `file:${TMP_DB}`);
    vi.stubEnv("AUDIT_FETCH_RETRIES", "0");
    vi.stubEnv("AUDIT_FETCH_TIMEOUT_MS", "2000");
    vi.stubEnv("AUDIT_RESPECT_ROBOTS_TXT", "false");
    vi.stubEnv("AUDIT_CONCURRENCY", "5");
    vi.stubEnv("AUDIT_MIN_DELAY_PER_HOST_MS", "0");
    vi.stubEnv("DNS_PROBE_ENABLED", "false");
    vi.stubEnv("CSE_DISCOVERY_ENABLED", "false");
    resetEnvCache();
    __resetDbClientForTests();
    resetRobotsCache();
    freshDb();

    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);
  });

  afterEach(async () => {
    await agent.close();
    setGlobalDispatcher(originalDispatcher);
    vi.unstubAllEnvs();
    resetEnvCache();
    __resetDbClientForTests();
  });

  it("classifies A-with-website and C-with-5xx correctly", async () => {
    // A-candidate: plain 200 home → Tier A with minimal signals.
    agent
      .get("https://www.faketesta.at")
      .intercept({ path: "/", method: "GET" })
      .reply(
        200,
        '<!doctype html><html lang="de"><head>' +
          '<meta name="viewport" content="width=device-width">' +
          "<title>Testa Café - Wien Favoriten</title>" +
          "</head><body>" +
          "<h1>Testa Café</h1>" +
          "<p>Willkommen bei Testa - Ihrem Café in Wien-Favoriten.</p>" +
          "<p>Unser Sortiment umfasst Kaffee, Gebäck, Frühstück und Mittagsmenüs.</p>" +
          "<p>Öffnungszeiten: Montag bis Freitag 07:00 bis 19:00, Samstag 08:00 bis 15:00.</p>" +
          "<p>Adresse: Favoritenstraße 42, 1100 Wien. Telefon +43 1 234 5678.</p>" +
          "<p>" +
          "Lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(20) +
          "</p>" +
          "</body></html>",
      )
      .persist();
    // Impressum paths + PSI all 404 for the A candidate (acceptable).
    for (const p of [
      "/impressum",
      "/imprint",
      "/legal",
      "/kontakt",
      "/about",
      "/ueber-uns",
    ]) {
      agent
        .get("https://www.faketesta.at")
        .intercept({ path: p, method: "GET" })
        .reply(404, "")
        .persist();
    }
    // PSI endpoint — return 400 so we skip retries fast (invalid URL path).
    agent
      .get("https://www.googleapis.com")
      .intercept({ path: (p) => p.startsWith("/pagespeedonline"), method: "GET" })
      .reply(400, "{}")
      .persist();
    // C-candidate: home returns 500.
    agent
      .get("https://www.fakedead.at")
      .intercept({ path: "/", method: "GET" })
      .reply(500, "server error")
      .persist();

    const candidates: PlaceCandidate[] = [
      candidate({
        placeId: "A-cand",
        name: "A Candidate",
        website: "https://www.faketesta.at",
      }),
      candidate({
        placeId: "C-cand",
        name: "C Candidate",
        website: "https://www.fakedead.at",
      }),
    ];

    await runAudit({
      limit: 10,
      discover: async () => candidates,
    });

    // Verify DB state directly via raw SQLite — avoids re-importing the
    // drizzle client after our env/cache fiddle.
    const sql = new Database(TMP_DB, { readonly: true });
    const rows = sql
      .prepare("SELECT place_id, tier, score FROM audit_results ORDER BY place_id")
      .all() as Array<{ place_id: string; tier: string; score: number | null }>;
    sql.close();

    expect(rows).toHaveLength(2);
    const byId = Object.fromEntries(rows.map((r) => [r.place_id, r]));
    expect(byId["A-cand"]!.tier).toBe("A");
    expect(byId["C-cand"]!.tier).toBe("C");
    expect(byId["C-cand"]!.score).toBe(9);
    // Tier A score is non-deterministic in detail but must be in range.
    expect(byId["A-cand"]!.score).toBeGreaterThanOrEqual(0);
    expect(byId["A-cand"]!.score).toBeLessThanOrEqual(30);
  });
});
