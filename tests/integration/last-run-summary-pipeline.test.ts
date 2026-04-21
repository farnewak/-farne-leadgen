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

// Mock SSL + PSI so the pipeline never hits the network. Every fixture
// URL is intercepted via MockAgent below.
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
const TMP_DB = resolve(HERE, "../tmp/last-run-summary-pipeline.db");
const TMP_LOG_DIR = resolve(HERE, "../tmp/last-run-summary-pipeline-logs");
const TMP_REPORT = resolve(
  HERE,
  "../tmp/last-run-summary-pipeline/last_run_summary.md",
);
const FIXTURE_PATH = resolve(HERE, "../fixtures/stage1_inputs.json");
const FIXED_NOW = new Date("2026-04-20T12:00:00.000Z");

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

interface FixtureRecord extends Omit<PlaceCandidate, "name"> {
  id: string;
  name: string | null;
}

function loadFixtures(ids: string[]): PlaceCandidate[] {
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  const records = JSON.parse(raw) as FixtureRecord[];
  return records
    .filter((r) => ids.includes(r.id))
    .map(({ id: _id, ...rest }) => rest) as unknown as PlaceCandidate[];
}

describe("runAudit → last_run_summary.md (R1/R3/R6 fixtures)", () => {
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
      rmSync(dirname(TMP_REPORT), { recursive: true, force: true });
    } catch {
      // best-effort
    }

    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);

    // R1: Tier-A business with incomplete impressum.
    agent
      .get("https://www.kleinmeister-cafe.at")
      .intercept({ path: "/", method: "GET" })
      .reply(
        200,
        "<!doctype html><html><head><title>Kleinmeister</title></head>" +
          "<body><h1>Kleinmeister Café</h1></body></html>",
      )
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
        .reply(
          p === "/impressum" ? 200 : 404,
          p === "/impressum"
            ? "<!doctype html><html><body>" +
                "<h1>Impressum</h1>" +
                "<p>Kleinmeister Café GmbH</p>" +
                "<p>Wipplingerstraße 14, 1010 Wien</p>" +
                "</body></html>"
            : "",
        )
        .persist();
    }

    // R6: WordPress carpenter, Tier-A.
    agent
      .get("https://wp-ladenbau.at")
      .intercept({ path: "/", method: "GET" })
      .reply(
        200,
        "<!doctype html><html><head>" +
          '<meta name="generator" content="WordPress 6.3.1">' +
          "<title>WP Ladenbau</title></head>" +
          '<body><link rel="stylesheet" href="/wp-content/themes/foo/style.css">' +
          "<h1>Ladenbau Wien</h1>" +
          "<footer>© 2020 WP Ladenbau Wien.</footer></body></html>",
      )
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
        .get("https://wp-ladenbau.at")
        .intercept({ path: p, method: "GET" })
        .reply(
          p === "/impressum" ? 200 : 404,
          p === "/impressum"
            ? "<!doctype html><html><body><h1>Impressum</h1>" +
                "<p>WP Ladenbau Wien e.U.</p>" +
                "<p>Handwerksweg 5, 1060 Wien</p></body></html>"
            : "",
        )
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
      rmSync(dirname(TMP_REPORT), { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("writes a summary with Top-10 Tier-A entry and R3 in B3 section", async () => {
    // R1 (Tier A) + R3 (B3, no URL) + R6 (Tier A WordPress). R2/R4/R5/R7
    // pulled out to keep this test scoped to the summary surface.
    const fixtures = loadFixtures([
      "R1_broken_site",
      "R3_nameless_osm",
      "R6_wordpress_dated",
    ]);

    await runAudit({
      limit: 10,
      discover: async () => fixtures,
      logDir: TMP_LOG_DIR,
      reportPath: TMP_REPORT,
    });

    const md = readFileSync(TMP_REPORT, "utf8");

    // Every section header must be present and free of placeholder tokens.
    for (const h of [
      "## (a) Run metadata",
      "## (b) Tier distribution",
      "## (c) Sub_tier distribution",
      "## (d) Intent_tier distribution",
      "## (e) Score per sub_tier",
      "## (f) Top-10 worst Tier-A",
      "## (g) All B3 records",
      "## (h) Chain summary",
      "## (i) CMS distribution",
      "## (j) last_modified_signal decade buckets",
      "## (k) email_is_generic counts",
    ]) {
      expect(md).toContain(h);
    }
    expect(md).not.toMatch(/undefined/);
    expect(md).not.toMatch(/\bNaN\b/);

    // Section (f): at least one Tier-A row (R1 or R6).
    const secF = md.match(/## \(f\)[\s\S]*?(?=## )/)?.[0] ?? "";
    const fLines = secF
      .split("\n")
      .filter((l) => l.startsWith("|") && !l.includes("---") && !l.includes("name "));
    expect(fLines.length).toBeGreaterThanOrEqual(1);
    expect(secF).not.toContain("| (none) |");

    // Section (g): R3 (osm:node:100000003) present.
    const secG = md.match(/## \(g\)[\s\S]*?(?=## )/)?.[0] ?? "";
    expect(secG).toContain("osm:node:100000003");
  });
});
