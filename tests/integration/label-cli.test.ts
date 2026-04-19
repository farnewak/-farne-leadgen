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
  writeFileSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { main as labelMain } from "../../src/cli/label.js";
import { main as exportLabelsMain } from "../../src/cli/export-labels.js";
import { resetEnvCache } from "../../src/lib/env.js";
import { __resetDbClientForTests } from "../../src/db/client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP_DB = resolve(HERE, "../tmp/label-cli.db");
const TMP_OUT = resolve(HERE, "../tmp/label-cli-out");

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

function seedAuditRow(placeId: string, score: number): void {
  const sql = new Database(TMP_DB);
  const now = new Date("2026-04-10T00:00:00.000Z").getTime();
  sql
    .prepare(
      `INSERT INTO audit_results (
        place_id, audited_at, tier, discovered_url, discovery_method,
        ssl_valid, http_to_https_redirect, has_viewport_meta,
        psi_mobile_performance, impressum_present, impressum_uid,
        impressum_company_name, impressum_address, impressum_phone,
        impressum_email, impressum_complete,
        tech_stack, generic_emails, social_links,
        static_signals_expires_at, psi_signals_expires_at, score, intent_tier
      ) VALUES (?, ?, 'A', 'https://example.at', 'osm-tag',
                1, 1, 1, 80, 1, 'ATU12345678', 'Example GmbH',
                'Mariahilferstr 1, 1060 Wien', '+43123456', 'x@example.at', 1,
                '{"cms":[],"pageBuilder":[],"analytics":["ga"],"tracking":[],"payment":[],"cdn":[]}',
                '[]', '{"facebook":"https://facebook.com/x"}',
                ?, NULL, ?, 'LIVE')`,
    )
    .run(placeId, now, now + 30 * 86_400_000, score);
  sql.close();
}

function countRows(table: string): number {
  const sql = new Database(TMP_DB);
  const row = sql
    .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
    .get() as { n: number };
  sql.close();
  return row.n;
}

describe("leadgen label / export-labels CLI (integration)", () => {
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

  it("single label insert: INTERESSIERT + CALL + note", async () => {
    seedAuditRow("p0", 12);
    await labelMain([
      "p0",
      "INTERESSIERT",
      "--channel",
      "CALL",
      "--note",
      "Rückruf am 22.4.",
    ]);
    expect(countRows("lead_outcomes")).toBe(1);
    expect(stdoutBuf.join("")).toContain("1 labels collected");

    const sql = new Database(TMP_DB);
    const row = sql
      .prepare("SELECT * FROM lead_outcomes WHERE lead_id = ?")
      .get("p0") as {
        lead_id: string;
        status: string;
        channel: string | null;
        notes: string | null;
      };
    sql.close();
    expect(row.status).toBe("INTERESSIERT");
    expect(row.channel).toBe("CALL");
    expect(row.notes).toBe("Rückruf am 22.4.");
  });

  it("append-only: two labels for same lead_id → two rows", async () => {
    seedAuditRow("p0", 12);
    await labelMain(["p0", "NO_ANSWER"]);
    await labelMain(["p0", "INTERESSIERT", "--channel", "CALL"]);
    expect(countRows("lead_outcomes")).toBe(2);
  });

  it("invalid status → throws (CLI dispatcher turns into exit 1)", async () => {
    seedAuditRow("p0", 12);
    await expect(labelMain(["p0", "BOGUS_STATUS"])).rejects.toThrow(
      /invalid status/,
    );
    expect(countRows("lead_outcomes")).toBe(0);
  });

  it("invalid channel → throws", async () => {
    seedAuditRow("p0", 12);
    await expect(
      labelMain(["p0", "INTERESSIERT", "--channel", "FAX"]),
    ).rejects.toThrow(/invalid --channel/);
    expect(countRows("lead_outcomes")).toBe(0);
  });

  it("bulk --csv import with 10 rows", async () => {
    for (let i = 0; i < 10; i++) seedAuditRow(`p${i}`, 10 + i);

    const csvPath = resolve(TMP_OUT, "labels.csv");
    const rows: string[] = ["lead_id,status,channel,notes"];
    const statuses = [
      "INTERESSIERT",
      "GESCHLOSSEN",
      "NICHT_RELEVANT",
      "NO_ANSWER",
      "FOLLOWUP",
    ];
    const channels = ["MAIL", "CALL", "BESUCH"];
    for (let i = 0; i < 10; i++) {
      const status = statuses[i % statuses.length];
      const channel = i % 2 === 0 ? channels[i % channels.length] : "";
      const notes = i === 3 ? `"multi,line note ""quoted"""` : "";
      rows.push(`p${i},${status},${channel},${notes}`);
    }
    writeFileSync(csvPath, rows.join("\n"), "utf8");

    await labelMain(["--csv", csvPath]);
    expect(countRows("lead_outcomes")).toBe(10);
    expect(stdoutBuf.join("")).toContain("10 labels collected");

    const sql = new Database(TMP_DB);
    const row3 = sql
      .prepare("SELECT notes FROM lead_outcomes WHERE lead_id = ?")
      .get("p3") as { notes: string };
    sql.close();
    expect(row3.notes).toBe('multi,line note "quoted"');
  });

  it("bulk --csv rejects invalid status on a row without partial commit", async () => {
    for (let i = 0; i < 3; i++) seedAuditRow(`p${i}`, 10);
    const csvPath = resolve(TMP_OUT, "bad.csv");
    writeFileSync(
      csvPath,
      [
        "lead_id,status,channel,notes",
        "p0,INTERESSIERT,,",
        "p1,WAT,,",
      ].join("\n"),
      "utf8",
    );
    await expect(labelMain(["--csv", csvPath])).rejects.toThrow(
      /invalid status "WAT"/,
    );
    // Validation happens up-front in parseCsv → no partial writes.
    expect(countRows("lead_outcomes")).toBe(0);
  });

  it("export-labels emits JSONL with lead_id/status/channel/features/score", async () => {
    seedAuditRow("p0", 12);
    seedAuditRow("p1", 8);
    await labelMain(["p0", "INTERESSIERT", "--channel", "CALL"]);
    await labelMain(["p1", "GESCHLOSSEN", "--channel", "MAIL"]);

    const out = resolve(TMP_OUT, "training.jsonl");
    await exportLabelsMain(["--output", out]);

    const text = readFileSync(out, "utf8");
    const lines = text.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const obj = JSON.parse(line) as Record<string, unknown>;
      // Required top-level keys.
      for (const k of [
        "lead_id",
        "status",
        "channel",
        "features",
        "score",
        "created_at",
        "notes",
      ]) {
        expect(Object.keys(obj)).toContain(k);
      }
      const features = obj.features as Record<string, unknown>;
      // Snapshot keys come from the seeded Tier-A audit row. Drizzle's
      // SQLite driver decodes `mode: "boolean"` columns to real booleans.
      expect(features.tier).toBe("A");
      expect(features.sslValid).toBe(true);
      expect(features.impressumPresent).toBe(true);
      expect(features.intentTier).toBe("LIVE");
      // score is promoted to a top-level key.
      expect(typeof obj.score).toBe("number");
    }
  });

  it("export-labels warns (stderr) when lead_id has no audit row", async () => {
    // Don't seed audit_results; label an unknown lead.
    await labelMain(["ghost", "NO_ANSWER"]);
    const out = resolve(TMP_OUT, "ghost.jsonl");
    await exportLabelsMain(["--output", out]);

    const line = JSON.parse(
      readFileSync(out, "utf8").split("\n")[0] ?? "",
    ) as Record<string, unknown>;
    expect(line.lead_id).toBe("ghost");
    expect(line.score).toBeNull();
    expect(line.features).toEqual({});
    expect(stderrBuf.join("")).toMatch(/no audit_results row/);
  });
});
