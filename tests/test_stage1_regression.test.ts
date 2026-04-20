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

// Stub the network-dependent signal collectors so the snapshot is deterministic
// regardless of whether CI can resolve DNS. `vi.mock` hoists above every import
// in this file — keep these mocks narrow (one function each) so tests can still
// observe every column the real builders would populate.
vi.mock("../src/pipeline/ssl-check.js", () => ({
  checkTransport: vi.fn(async (_host: string) => ({
    sslValid: false,
    sslExpiresAt: null,
    httpToHttpsRedirect: false,
    fetchError: "CERT_INVALID" as const,
  })),
}));

vi.mock("../src/pipeline/psi.js", () => ({
  runPsiMobile: vi.fn(async (_url: string) => ({
    performance: null,
    seo: null,
    accessibility: null,
    bestPractices: null,
    fetchedAt: new Date("2026-04-20T12:00:00.000Z"),
    error: "CLIENT_ERROR" as const,
  })),
}));

import { runAudit } from "../src/pipeline/audit.js";
import { rowToExportShape } from "../src/pipeline/export.js";
import { resetEnvCache } from "../src/lib/env.js";
import { __resetDbClientForTests } from "../src/db/client.js";
import { resetRobotsCache } from "../src/pipeline/robots.js";
import type { PlaceCandidate } from "../src/models/types.js";
import type { AuditResult } from "../src/db/schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP_DB = resolve(HERE, "tmp/stage1-regression.db");
const FIXTURE_PATH = resolve(HERE, "fixtures/stage1_inputs.json");
const FIXED_NOW = new Date("2026-04-20T12:00:00.000Z");

interface FixtureRecord extends Omit<PlaceCandidate, "name"> {
  id: string;
  // Fixture allows null to mirror the raw "nameless OSM record" shape; the
  // pipeline itself does not filter at this layer because discovery is
  // bypassed via the `discover` hook.
  name: string | null;
}

function freshDb(): void {
  try {
    rmSync(TMP_DB, { force: true });
    rmSync(`${TMP_DB}-wal`, { force: true });
    rmSync(`${TMP_DB}-shm`, { force: true });
  } catch {
    // tmp file may not exist yet
  }
  mkdirSync(dirname(TMP_DB), { recursive: true });
  const sql = new Database(TMP_DB);
  const migrations = [
    "0000_init.sql",
    "0001_audit_results.sql",
    "0002_intent_tier.sql",
    "0003_lead_outcomes.sql",
  ].map((f) =>
    readFileSync(resolve(HERE, "../src/db/migrations/sqlite", f), "utf8"),
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

function loadFixtures(): PlaceCandidate[] {
  const raw = readFileSync(FIXTURE_PATH, "utf-8");
  const records = JSON.parse(raw) as FixtureRecord[];
  // Cast away the null-name escape hatch: the pipeline accepts whatever the
  // discover hook returns, mirroring what OSM would hand over pre-filter.
  return records.map(({ id: _id, ...rest }) => rest) as unknown as PlaceCandidate[];
}

function readAuditRows(): AuditResult[] {
  const sql = new Database(TMP_DB, { readonly: true });
  try {
    const rows = sql
      .prepare(
        "SELECT * FROM audit_results ORDER BY place_id",
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(hydrateRow);
  } finally {
    sql.close();
  }
}

// Drizzle's select() deserialises JSON / timestamp columns automatically; the
// raw better-sqlite3 read does not. Re-hydrate the minimal subset of columns
// the exporter reads so the snapshot matches what the production export path
// would produce.
function hydrateRow(row: Record<string, unknown>): AuditResult {
  const parseJson = <T>(v: unknown, fallback: T): T => {
    if (typeof v !== "string") return fallback;
    try {
      return JSON.parse(v) as T;
    } catch {
      return fallback;
    }
  };
  const asDate = (v: unknown): Date | null => {
    if (v == null) return null;
    return new Date(Number(v));
  };
  const asBool = (v: unknown): boolean | null => {
    if (v == null) return null;
    return Number(v) === 1;
  };
  return {
    id: Number(row.id),
    placeId: String(row.place_id),
    auditedAt: asDate(row.audited_at) as Date,
    tier: row.tier as AuditResult["tier"],
    discoveredUrl: (row.discovered_url as string | null) ?? null,
    discoveryMethod: row.discovery_method as AuditResult["discoveryMethod"],
    sslValid: asBool(row.ssl_valid),
    sslExpiresAt: asDate(row.ssl_expires_at),
    httpToHttpsRedirect: asBool(row.http_to_https_redirect),
    hasViewportMeta: asBool(row.has_viewport_meta),
    viewportMetaContent: (row.viewport_meta_content as string | null) ?? null,
    psiMobilePerformance: row.psi_mobile_performance as number | null,
    psiMobileSeo: row.psi_mobile_seo as number | null,
    psiMobileAccessibility: row.psi_mobile_accessibility as number | null,
    psiMobileBestPractices: row.psi_mobile_best_practices as number | null,
    psiFetchedAt: asDate(row.psi_fetched_at),
    impressumUrl: (row.impressum_url as string | null) ?? null,
    impressumPresent: Number(row.impressum_present) === 1,
    impressumUid: (row.impressum_uid as string | null) ?? null,
    impressumCompanyName: (row.impressum_company_name as string | null) ?? null,
    impressumAddress: (row.impressum_address as string | null) ?? null,
    impressumPhone: (row.impressum_phone as string | null) ?? null,
    impressumEmail: (row.impressum_email as string | null) ?? null,
    impressumComplete: asBool(row.impressum_complete),
    techStack: parseJson(row.tech_stack, {
      cms: [],
      pageBuilder: [],
      analytics: [],
      tracking: [],
      payment: [],
      cdn: [],
    }),
    genericEmails: parseJson(row.generic_emails, [] as string[]),
    socialLinks: parseJson(row.social_links, {}),
    fetchError: row.fetch_error as AuditResult["fetchError"],
    fetchErrorAt: asDate(row.fetch_error_at),
    intentTier: row.intent_tier as AuditResult["intentTier"],
    staticSignalsExpiresAt: asDate(row.static_signals_expires_at) as Date,
    psiSignalsExpiresAt: asDate(row.psi_signals_expires_at),
    score: row.score as number | null,
  };
}

describe("stage1 regression lock", () => {
  let agent: MockAgent;
  const originalDispatcher = getGlobalDispatcher();

  beforeEach(() => {
    // Fake only Date — setTimeout / setImmediate stay real so fetch-timeouts
    // and the host-limiter's deferred callbacks still resolve naturally.
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

    agent = new MockAgent();
    agent.disableNetConnect();
    setGlobalDispatcher(agent);

    // R1: plain home page with a partial Impressum. UID is missing on purpose
    // (`complete=false` scenario). No viewport meta, no structured data,
    // no analytics — signals that feed NO_MOBILE_VIEWPORT / NO_ANALYTICS.
    agent
      .get("https://www.kleinmeister-cafe.at")
      .intercept({ path: "/", method: "GET" })
      .reply(
        200,
        "<!doctype html><html><head><title>Kleinmeister</title></head>" +
          "<body><h1>Kleinmeister Café</h1>" +
          '<p>Wipplingerstraße 14, 1010 Wien, Telefon +43 1 555 1010.</p>' +
          "</body></html>",
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

    // R2: Spar branch page. Single 200 — every Impressum path 404s.
    agent
      .get("https://www.spar.at")
      .intercept({
        path: "/standorte/eurospar-wien-1030-landstrasser-hauptstrasse-146",
        method: "GET",
      })
      .reply(
        200,
        "<!doctype html><html><head><title>EUROSPAR Landstraßer Hauptstr. 146</title></head>" +
          "<body><h1>EUROSPAR</h1><p>Landstraßer Hauptstraße 146, 1030 Wien</p></body></html>",
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
        .get("https://www.spar.at")
        .intercept({ path: p, method: "GET" })
        .reply(404, "")
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
  });

  it("locks the full export row for R1/R2/R3 as-is", async () => {
    const fixtures = loadFixtures();

    await runAudit({
      limit: 10,
      discover: async () => fixtures,
    });

    const rows = readAuditRows();
    expect(rows).toHaveLength(3);

    const byId = Object.fromEntries(rows.map((r) => [r.placeId, r]));

    const r1 = rowToExportShape(byId["osm:node:100000001"]!);
    const r2 = rowToExportShape(byId["osm:node:100000002"]!);
    const r3 = rowToExportShape(byId["osm:node:100000003"]!);

    // Snapshot the full ExportRow shape for each fixture. No hand-written
    // assertions on specific columns — this is a regression lock, not a spec.
    expect(r1).toMatchInlineSnapshot(`
      {
        "address": "Wipplingerstraße 14, 1010 Wien",
        "audited_at": 2026-04-20T12:00:00.000Z,
        "cms": "",
        "coverage": "PA",
        "email": null,
        "email_is_generic": false,
        "has_social": false,
        "impressum_complete": null,
        "intent_tier": "PARKED",
        "name": "Kleinmeister-Cafe",
        "phone": "+43 1 555 1010",
        "place_id": "osm:node:100000001",
        "plz": "1010",
        "psi_mobile_performance": null,
        "score": 12,
        "score_breakdown": [
          {
            "delta": 12,
            "key": "DOMAIN_REGISTERED_NO_SITE",
          },
        ],
        "ssl_valid": null,
        "tier": "C",
        "uid": null,
        "url": "https://www.kleinmeister-cafe.at",
      }
    `);
    expect(r2).toMatchInlineSnapshot(`
      {
        "address": "Landstraßer Hauptstraße 146, 1030 Wien",
        "audited_at": 2026-04-20T12:00:00.000Z,
        "cms": "",
        "coverage": "PA",
        "email": null,
        "email_is_generic": false,
        "has_social": false,
        "impressum_complete": null,
        "intent_tier": "PARKED",
        "name": "Spar",
        "phone": "+43 1 711 11 0",
        "place_id": "osm:node:100000002",
        "plz": "1030",
        "psi_mobile_performance": null,
        "score": 12,
        "score_breakdown": [
          {
            "delta": 12,
            "key": "DOMAIN_REGISTERED_NO_SITE",
          },
        ],
        "ssl_valid": null,
        "tier": "C",
        "uid": null,
        "url": "https://www.spar.at/standorte/eurospar-wien-1030-landstrasser-hauptstrasse-146",
      }
    `);
    expect(r3).toMatchInlineSnapshot(`
      {
        "address": null,
        "audited_at": 2026-04-20T12:00:00.000Z,
        "cms": "",
        "coverage": "",
        "email": null,
        "email_is_generic": false,
        "has_social": false,
        "impressum_complete": null,
        "intent_tier": null,
        "name": "",
        "phone": null,
        "place_id": "osm:node:100000003",
        "plz": null,
        "psi_mobile_performance": null,
        "score": 9,
        "score_breakdown": [
          {
            "delta": 9,
            "key": "DEAD_WEBSITE",
          },
        ],
        "ssl_valid": null,
        "tier": "C",
        "uid": null,
        "url": null,
      }
    `);
  });
});
