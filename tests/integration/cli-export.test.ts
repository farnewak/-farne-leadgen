import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import {
  readFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { main as exportMain } from "../../src/cli/export.js";
import { resetEnvCache } from "../../src/lib/env.js";
import { __resetDbClientForTests } from "../../src/db/client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP_DB = resolve(HERE, "../tmp/cli-export.db");
const TMP_OUT = resolve(HERE, "../tmp/cli-export-out");

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
    "0003_lead_outcomes.sql",
    "0004_chain_apex_dedupe.sql",
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

// Seeds N rows with deterministic field values. Score distribution:
//   i=0    → score 0  / Tier A  (all signals clean)
//   i=1..3 → score 7  / Tier B1 (ONLY_SOCIAL)
//   i=4..6 → score 6  / Tier B2 (ONLY_DIRECTORY)
//   i=7..N → score 20 / Tier B3 (NO_WEBSITE post FIX 7)
// All rows are FIX 3 invariant-compliant: a legitimate tier=C row must
// have score=null + intent_tier∈{null,AUDIT_ERROR,TIMEOUT,PARKED}, so
// the seed uses tier=B3 for the "no-site" bucket (matches FIX 4 behaviour).
// Stored score matches what rebuildScoreInput would compute, so no
// mismatch-warnings fire during export.
function seedRows(count: number): void {
  const sql = new Database(TMP_DB);
  const insert = sql.prepare(
    `INSERT INTO audit_results (
      place_id, audited_at, tier, discovered_url, discovery_method,
      ssl_valid, http_to_https_redirect, has_viewport_meta,
      psi_mobile_performance,
      impressum_url, impressum_present, impressum_uid,
      impressum_company_name, impressum_address, impressum_phone,
      impressum_email, impressum_complete,
      tech_stack, generic_emails, social_links,
      static_signals_expires_at, psi_signals_expires_at, score
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date("2026-04-10T00:00:00.000Z").getTime();
  const fullyEmptyTech = JSON.stringify({
    cms: [],
    pageBuilder: [],
    analytics: [],
    tracking: [],
    payment: [],
    cdn: [],
  });
  const tierATech = JSON.stringify({
    cms: [],
    pageBuilder: [],
    analytics: ["ga"],
    tracking: ["fb-pixel"],
    payment: [],
    cdn: [],
  });
  const tierASocial = JSON.stringify({
    facebook: "https://facebook.com/x",
  });
  for (let i = 0; i < count; i++) {
    let tier: string;
    let score: number;
    if (i === 0) {
      tier = "A";
      score = 0; // all signals clean → 0
    } else if (i <= 3) {
      tier = "B1";
      score = 7; // ONLY_SOCIAL
    } else if (i <= 6) {
      tier = "B2";
      score = 6; // ONLY_DIRECTORY
    } else {
      tier = "B3";
      score = 20; // NO_WEBSITE post FIX 7
    }
    insert.run(
      `p${i}`,
      now + i,
      tier,
      tier === "A" ? "https://www.example.at" : null,
      tier === "A" ? "osm-tag" : null,
      tier === "A" ? 1 : null,
      tier === "A" ? 1 : null,
      tier === "A" ? 1 : null,
      tier === "A" ? 80 : null,
      null,
      tier === "A" ? 1 : 0,
      tier === "A" ? "ATU12345678" : null,
      tier === "A" ? "Example GmbH" : null,
      tier === "A" ? "Mariahilferstr 1, 1060 Wien" : null,
      null,
      null,
      tier === "A" ? 1 : null,
      tier === "A" ? tierATech : fullyEmptyTech,
      "[]",
      tier === "A" ? tierASocial : "{}",
      now + 30 * 86_400_000,
      null,
      score,
    );
  }
  sql.close();
}

describe("leadgen export CLI (integration)", () => {
  let stderrBuf: string[] = [];
  let stdoutBuf: string[] = [];
  const origStderrWrite = process.stderr.write.bind(process.stderr);
  const origStdoutWrite = process.stdout.write.bind(process.stdout);

  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("DATABASE_URL", `file:${TMP_DB}`);
    resetEnvCache();
    __resetDbClientForTests();
    freshDb();
    mkdirSync(TMP_OUT, { recursive: true });
    stderrBuf = [];
    stdoutBuf = [];
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrBuf.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutBuf.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stderr.write = origStderrWrite;
    process.stdout.write = origStdoutWrite;
    vi.unstubAllEnvs();
    resetEnvCache();
    __resetDbClientForTests();
  });

  it("seeded DB with 10 rows → CSV has 11 lines (header + 10)", async () => {
    seedRows(10);
    const out = resolve(TMP_OUT, "all.csv");
    await exportMain(["--output", out]);
    expect(existsSync(out)).toBe(true);
    const content = readFileSync(out, "utf8");
    // Starts with UTF-8 BOM.
    expect(content.charCodeAt(0)).toBe(0xfeff);
    // Header + 10 rows + trailing CRLF → split on CRLF yields 12 (last empty).
    const lines = content.replace(/^\uFEFF/, "").split("\r\n");
    expect(lines).toHaveLength(12);
    expect(lines[11]).toBe("");
    expect(stderrBuf.join("")).toBe("");
  });

  it("--tier B1 --limit 2 → CSV has 3 lines (header + 2)", async () => {
    seedRows(10);
    const out = resolve(TMP_OUT, "b1.csv");
    await exportMain(["--tier", "B1", "--limit", "2", "--output", out]);
    const content = readFileSync(out, "utf8");
    const lines = content.replace(/^\uFEFF/, "").split("\r\n");
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe("");
    // Both rows are tier B1.
    for (const line of lines.slice(1, 3)) {
      expect(line.split(";")[1]).toBe("B1");
    }
  });

  it("empty result set → CSV with header only, no stderr", async () => {
    seedRows(10);
    const out = resolve(TMP_OUT, "empty.csv");
    // min-score=100 → 0 rows match.
    await exportMain(["--min-score", "100", "--output", out]);
    const content = readFileSync(out, "utf8");
    const lines = content.replace(/^\uFEFF/, "").split("\r\n");
    // Header + trailing CRLF → 2 entries (header + "").
    expect(lines).toHaveLength(2);
    expect(lines[0]!.split(";")[0]).toBe("place_id");
    expect(lines[1]).toBe("");
    expect(stderrBuf.join("")).toBe("");
  });

  it("--format json emits valid JSON array", async () => {
    seedRows(10);
    const out = resolve(TMP_OUT, "all.json");
    await exportMain(["--format", "json", "--output", out]);
    const parsed = JSON.parse(readFileSync(out, "utf8")) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as unknown[]).length).toBe(10);
  });

  // T-Inf-4: seed a Tier-A row whose stored score is 1 less than what the
  // rebuilt signals would recompute (simulating has_structured_data having
  // fired at audit-time but not being persisted). Export must emit no WARN
  // and the breakdown deltas must sum to the stored score.
  it("T-Inf-4: structured-data gap=1 row → no stderr, breakdown sum == score", async () => {
    const sql = new Database(TMP_DB);
    const tierATech = JSON.stringify({
      cms: [],
      pageBuilder: [],
      analytics: ["ga"],
      tracking: ["fb-pixel"],
      payment: [],
      cdn: [],
    });
    const tierASocial = JSON.stringify({ facebook: "https://facebook.com/x" });
    const now = new Date("2026-04-10T00:00:00.000Z").getTime();
    // Signal mix: NO_SSL+3 = 3 pre-inference. stored=2 → gap=1.
    sql
      .prepare(
        `INSERT INTO audit_results (
          place_id, audited_at, tier, discovered_url, discovery_method,
          ssl_valid, http_to_https_redirect, has_viewport_meta,
          psi_mobile_performance,
          impressum_present, impressum_uid, impressum_company_name,
          impressum_address, impressum_complete,
          tech_stack, generic_emails, social_links,
          static_signals_expires_at, score
        ) VALUES (?, ?, 'A', ?, 'osm-tag', 0, 1, 1, 80, 1, 'ATU12345678',
                  'Structured GmbH', 'Mariahilferstr 1, 1060 Wien', 1,
                  ?, '[]', ?, ?, ?)`,
      )
      .run(
        "structured-p",
        now,
        "https://structured.example.at",
        tierATech,
        tierASocial,
        now + 30 * 86_400_000,
        2,
      );
    sql.close();

    const out = resolve(TMP_OUT, "structured.json");
    await exportMain(["--tier", "A", "--format", "json", "--output", out]);
    expect(stderrBuf.join("")).toBe("");

    const parsed = JSON.parse(readFileSync(out, "utf8")) as Array<{
      place_id: string;
      score: number;
      score_breakdown: Array<{ key: string; delta: number }>;
    }>;
    expect(parsed).toHaveLength(1);
    const row = parsed[0]!;
    expect(row.place_id).toBe("structured-p");
    expect(row.score).toBe(2);
    const sum = row.score_breakdown.reduce((s, e) => s + e.delta, 0);
    expect(sum).toBe(2);
    expect(row.score_breakdown.map((e) => e.key)).toContain(
      "HAS_STRUCTURED_DATA",
    );
  });
});
