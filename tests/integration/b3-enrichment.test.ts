import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";

// Neutralise the DNS probe: without this, B3 candidates (no website) trigger
// 6 real DNS lookups per candidate against disconnected MockAgent hosts,
// taking several seconds and blowing the 5s test timeout. Mocked to null
// so the discovery path falls through to enrichment immediately.
vi.mock("../../src/pipeline/dns-probe.js", () => ({
  discoverViaDns: async () => ({ found: false, reason: "DNS_PROBE_DISABLED" }),
}));
import { readFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
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
import type { PlacesQueryMatch } from "../../src/tools/datasources/google-places.js";
import {
  enrichB3Candidate,
  quotaFilePath,
} from "../../src/pipeline/enrich.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP_DB = resolve(HERE, "../tmp/b3-enrichment.db");
const TMP_CACHE = resolve(HERE, "../tmp/b3-enrichment-cache");

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
  for (const f of [TMP_DB, `${TMP_DB}-wal`, `${TMP_DB}-shm`]) {
    try {
      rmSync(f, { force: true });
    } catch {
      // ignore
    }
  }
  mkdirSync(dirname(TMP_DB), { recursive: true });
  const sql = new Database(TMP_DB);
  const migrations = [
    "0000_init.sql",
    "0001_audit_results.sql",
    "0002_intent_tier.sql",
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

function freshCache(): void {
  try {
    rmSync(TMP_CACHE, { recursive: true, force: true });
  } catch {
    // ignore
  }
  mkdirSync(TMP_CACHE, { recursive: true });
}

describe("B3 Google-Places enrichment (integration)", () => {
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
    vi.stubEnv("B3_ENRICHMENT_ENABLED", "true");
    vi.stubEnv("PLACES_CACHE_DIR", TMP_CACHE);
    vi.stubEnv("GOOGLE_PLACES_DAILY_QUOTA", "5000");
    resetEnvCache();
    __resetDbClientForTests();
    resetRobotsCache();
    freshDb();
    freshCache();

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

  it("B3 candidate with Places-website hit → re-classified to Tier A", async () => {
    // Mock a real working site for the enriched URL.
    agent
      .get("https://www.enrichedhit.at")
      .intercept({ path: "/", method: "GET" })
      .reply(
        200,
        '<!doctype html><html lang="de"><head>' +
          '<meta name="viewport" content="width=device-width">' +
          "<title>Enriched Shop - Wien</title>" +
          "</head><body>" +
          "<h1>Enriched Shop</h1>" +
          "<p>Willkommen im Enriched Shop — feine Waren, hochwertige Auswahl.</p>" +
          "<p>Unser Laden steht für Qualität und Service im Herzen Wiens.</p>" +
          "<p>Besuchen Sie uns in der Mariahilferstraße — wir freuen uns auf Sie.</p>" +
          "<p>" +
          "Lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(20) +
          "</p>" +
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
        .get("https://www.enrichedhit.at")
        .intercept({ path: p, method: "GET" })
        .reply(404, "")
        .persist();
    }
    agent
      .get("https://www.googleapis.com")
      .intercept({ path: (p) => p.startsWith("/pagespeedonline"), method: "GET" })
      .reply(400, "{}")
      .persist();

    const findPlaceByQuery = vi.fn(
      async (): Promise<PlacesQueryMatch | null> => ({
        websiteUri: "https://www.enrichedhit.at",
        phone: "+43 1 111 2222",
        formattedAddress: "Mariahilferstr 99, 1070 Wien",
        businessStatus: "OPERATIONAL",
      }),
    );

    await runAudit({
      limit: 10,
      discover: async () => [
        candidate({
          placeId: "b3-hit",
          name: "Enriched Shop",
          address: null,
          website: null,
        }),
      ],
      findPlaceByQuery,
      enrichCacheDir: TMP_CACHE,
    });

    expect(findPlaceByQuery).toHaveBeenCalledTimes(1);

    const sql = new Database(TMP_DB, { readonly: true });
    const row = sql
      .prepare(
        "SELECT place_id, tier, discovered_url, discovery_method FROM audit_results WHERE place_id='b3-hit'",
      )
      .get() as {
      place_id: string;
      tier: string;
      discovered_url: string | null;
      discovery_method: string | null;
    };
    sql.close();
    expect(row.tier).toBe("A");
    expect(row.discovered_url).toBe("https://www.enrichedhit.at");
    expect(row.discovery_method).toBe("gplaces-tag");
  });

  it("CLOSED_PERMANENTLY → candidate dropped (no DB row)", async () => {
    const findPlaceByQuery = vi.fn(
      async (): Promise<PlacesQueryMatch | null> => ({
        websiteUri: null,
        phone: null,
        formattedAddress: null,
        businessStatus: "CLOSED_PERMANENTLY",
      }),
    );
    await runAudit({
      limit: 10,
      discover: async () => [
        candidate({ placeId: "closed", name: "Ghost Café" }),
      ],
      findPlaceByQuery,
      enrichCacheDir: TMP_CACHE,
    });

    const sql = new Database(TMP_DB, { readonly: true });
    const rows = sql
      .prepare("SELECT place_id FROM audit_results")
      .all() as Array<{ place_id: string }>;
    sql.close();
    expect(rows).toHaveLength(0);
  });

  it("no-match → candidate stays B3 with impressum-phone/address = null", async () => {
    const findPlaceByQuery = vi.fn(
      async (): Promise<PlacesQueryMatch | null> => null,
    );
    await runAudit({
      limit: 10,
      discover: async () => [
        candidate({ placeId: "no-match-b3", name: "Obscure Krämerei" }),
      ],
      findPlaceByQuery,
      enrichCacheDir: TMP_CACHE,
    });

    const sql = new Database(TMP_DB, { readonly: true });
    const row = sql
      .prepare(
        "SELECT place_id, tier, impressum_phone, impressum_address FROM audit_results WHERE place_id='no-match-b3'",
      )
      .get() as {
      place_id: string;
      tier: string;
      impressum_phone: string | null;
      impressum_address: string | null;
    };
    sql.close();
    expect(row.tier).toBe("B3");
    expect(row.impressum_phone).toBeNull();
    expect(row.impressum_address).toBeNull();
  });

  it("quota-exhausted → skipped, candidate stays B3, no API call made", async () => {
    // Pre-seed quota file at exactly the daily limit.
    mkdirSync(TMP_CACHE, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    await (async () => {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(
        quotaFilePath(TMP_CACHE),
        JSON.stringify({ date: today, count: 5000 }),
      );
    })();

    const findPlaceByQuery = vi.fn(
      async (): Promise<PlacesQueryMatch | null> => ({
        websiteUri: "https://should-not-be-called.at",
        phone: null,
        formattedAddress: null,
        businessStatus: "OPERATIONAL",
      }),
    );
    await runAudit({
      limit: 10,
      discover: async () => [
        candidate({ placeId: "quota-b3", name: "Quota Candidate" }),
      ],
      findPlaceByQuery,
      enrichCacheDir: TMP_CACHE,
    });

    expect(findPlaceByQuery).not.toHaveBeenCalled();

    const sql = new Database(TMP_DB, { readonly: true });
    const row = sql
      .prepare(
        "SELECT tier FROM audit_results WHERE place_id='quota-b3'",
      )
      .get() as { tier: string };
    sql.close();
    expect(row.tier).toBe("B3");
  });

  it("cache hit on second call → no API call, verdict derived from cache", async () => {
    const cand = candidate({
      placeId: "cache-cand",
      name: "Cache Test",
      address: "Teststrasse 1",
    });
    const findPlaceByQuery = vi.fn(
      async (): Promise<PlacesQueryMatch | null> => ({
        websiteUri: "https://cache-site.at",
        phone: "+43 1 0000000",
        formattedAddress: "Teststrasse 1, 1010 Wien",
        businessStatus: "OPERATIONAL",
      }),
    );

    // First call — populates the cache.
    const first = await enrichB3Candidate(cand, {
      findPlaceByQuery,
      cacheDir: TMP_CACHE,
    });
    expect(first.verdict).toBe("updated");
    expect(first.cacheHit).toBe(false);
    expect(findPlaceByQuery).toHaveBeenCalledTimes(1);

    // Second call — same candidate → cache hit, no additional API call.
    const second = await enrichB3Candidate(cand, {
      findPlaceByQuery,
      cacheDir: TMP_CACHE,
    });
    expect(second.verdict).toBe("updated");
    expect(second.cacheHit).toBe(true);
    expect(findPlaceByQuery).toHaveBeenCalledTimes(1);

    // Cache file must exist.
    const hash = (await import("node:crypto"))
      .createHash("sha256")
      .update(`${cand.name}|${cand.address ?? ""}`)
      .digest("hex");
    expect(existsSync(resolve(TMP_CACHE, `${hash}.json`))).toBe(true);
  });

  it("enrichment fills missing phone/address (OSM priority preserved)", async () => {
    const findPlaceByQuery = vi.fn(
      async (): Promise<PlacesQueryMatch | null> => ({
        websiteUri: null,
        phone: "+43 1 222 333 4",
        formattedAddress: "Leopoldgasse 5, 1020 Wien",
        businessStatus: "OPERATIONAL",
      }),
    );
    // Candidate already has OSM-sourced phone — must NOT be overwritten.
    await runAudit({
      limit: 10,
      discover: async () => [
        candidate({
          placeId: "osm-priority",
          name: "Priority Shop",
          phone: "+43 OSM PHONE",
          address: null,
        }),
      ],
      findPlaceByQuery,
      enrichCacheDir: TMP_CACHE,
    });

    const sql = new Database(TMP_DB, { readonly: true });
    const row = sql
      .prepare(
        "SELECT impressum_phone, impressum_address FROM audit_results WHERE place_id='osm-priority'",
      )
      .get() as {
      impressum_phone: string | null;
      impressum_address: string | null;
    };
    sql.close();
    // OSM phone kept.
    expect(row.impressum_phone).toBe("+43 OSM PHONE");
    // Address was empty → filled from Places.
    expect(row.impressum_address).toBe("Leopoldgasse 5, 1020 Wien");
  });
});
