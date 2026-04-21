import { describe, it, expect } from "vitest";
import {
  filterRows,
  sortRows,
  toCsv,
  toJson,
  rowToExportShape,
  hostnameFallback,
  extractPlzFromAddress,
  type ExportRow,
  type ExportFilterOptions,
} from "../../src/pipeline/export.js";
import type { AuditResult } from "../../src/db/schema.js";
import type {
  TechStackSignals,
  SocialLinks,
  Tier,
} from "../../src/models/audit.js";

const EMPTY_TECH: TechStackSignals = {
  cms: [],
  pageBuilder: [],
  analytics: [],
  tracking: [],
  payment: [],
  cdn: [],
};
const EMPTY_SOCIAL: SocialLinks = {};

function row(overrides: Partial<ExportRow> = {}): ExportRow {
  return {
    place_id: "p1",
    tier: "A",
    intent_tier: null,
    score: 10,
    name: "Test",
    url: "https://example.at",
    phone: null,
    email: null,
    email_is_generic: false,
    address: null,
    plz: null,
    uid: null,
    impressum_complete: null,
    coverage: "",
    psi_mobile_performance: null,
    ssl_valid: null,
    cms: "",
    has_social: false,
    audited_at: new Date("2026-04-01T00:00:00.000Z"),
    score_breakdown: [],
    chain_detected: false,
    chain_name: null,
    branch_count: 1,
    sub_tier: null,
    ...overrides,
  };
}

function defaultFilter(
  overrides: Partial<ExportFilterOptions> = {},
): ExportFilterOptions {
  return {
    tiers: null,
    plzList: null,
    minScore: 0,
    maxScore: 30,
    limit: null,
    ...overrides,
  };
}

function auditRow(overrides: Partial<AuditResult> = {}): AuditResult {
  return {
    id: 1,
    placeId: "p1",
    auditedAt: new Date("2026-04-10T12:00:00.000Z"),
    tier: "A",
    discoveredUrl: "https://example.at",
    discoveryMethod: "osm-tag",
    sslValid: true,
    sslExpiresAt: null,
    httpToHttpsRedirect: true,
    hasViewportMeta: true,
    viewportMetaContent: null,
    psiMobilePerformance: 80,
    psiMobileSeo: null,
    psiMobileAccessibility: null,
    psiMobileBestPractices: null,
    psiFetchedAt: null,
    impressumUrl: null,
    impressumPresent: true,
    impressumUid: "ATU12345678",
    impressumCompanyName: "Example GmbH",
    impressumAddress: "Mariahilferstr 1, 1060 Wien",
    impressumPhone: "+43 1 234567",
    impressumEmail: "office@example.at",
    impressumComplete: true,
    techStack: EMPTY_TECH,
    genericEmails: [],
    socialLinks: EMPTY_SOCIAL,
    fetchError: null,
    fetchErrorAt: null,
    staticSignalsExpiresAt: new Date("2026-05-10T12:00:00.000Z"),
    psiSignalsExpiresAt: null,
    score: 3,
    chainDetected: false,
    chainName: null,
    branchCount: 1,
    ...overrides,
  } as AuditResult;
}

describe("filterRows — tier/plz/score/limit", () => {
  const rows: ExportRow[] = [
    row({ place_id: "a1", tier: "A", score: 20, plz: "1010" }),
    row({ place_id: "b1", tier: "B1", score: 15, plz: "1030" }),
    row({ place_id: "b2", tier: "B2", score: 10, plz: "1040" }),
    row({ place_id: "b3", tier: "B3", score: 8, plz: null }),
    row({ place_id: "c1", tier: "C", score: 5, plz: "1020" }),
  ];

  it("tiers=[A] returns only Tier A rows", () => {
    const out = filterRows(rows, defaultFilter({ tiers: ["A"] }));
    expect(out).toHaveLength(1);
    expect(out[0]!.place_id).toBe("a1");
  });

  it("plzList=[1030,1040] OR-matches", () => {
    const out = filterRows(rows, defaultFilter({ plzList: ["1030", "1040"] }));
    expect(out.map((r) => r.place_id).sort()).toEqual(["b1", "b2"]);
  });

  it("min-score=5 max-score=15 inclusive on both ends", () => {
    const out = filterRows(rows, defaultFilter({ minScore: 5, maxScore: 15 }));
    expect(out.map((r) => r.place_id).sort()).toEqual(["b1", "b2", "b3", "c1"]);
  });

  it("limit=3 caps after sort", () => {
    const out = filterRows(rows, defaultFilter({ limit: 3 }));
    expect(out).toHaveLength(3);
    expect(out.map((r) => r.place_id)).toEqual(["a1", "b1", "b2"]);
  });
});

describe("sortRows", () => {
  it("sorts score DESC, tiebreak audited_at DESC", () => {
    const rows: ExportRow[] = [
      row({
        place_id: "older",
        score: 10,
        audited_at: new Date("2026-03-01T00:00:00.000Z"),
      }),
      row({
        place_id: "newer",
        score: 10,
        audited_at: new Date("2026-04-10T00:00:00.000Z"),
      }),
      row({ place_id: "highest", score: 20 }),
    ];
    const sorted = sortRows(rows);
    expect(sorted.map((r) => r.place_id)).toEqual(["highest", "newer", "older"]);
  });
});

describe("toCsv — byte-level invariants", () => {
  const r = row({
    place_id: "p1",
    tier: "A",
    score: 7,
    name: "Kaffee & Kuchen",
    ssl_valid: true,
    audited_at: new Date("2026-04-10T12:00:00.000Z"),
  });
  const csv = toCsv([r]);

  it("first 3 bytes are UTF-8 BOM (0xEF 0xBB 0xBF)", () => {
    const buf = Buffer.from(csv, "utf8");
    expect(buf[0]).toBe(0xef);
    expect(buf[1]).toBe(0xbb);
    expect(buf[2]).toBe(0xbf);
  });

  it("lines are CRLF-terminated", () => {
    // Header + 1 row + trailing CRLF → two CRLFs internally + one trailing.
    expect(csv).toContain("\r\n");
    // No bare LFs outside CRLF.
    const stripped = csv.replace(/\r\n/g, "");
    expect(stripped).not.toContain("\n");
  });

  it("columns are semicolon-separated", () => {
    const header = csv.replace("\uFEFF", "").split("\r\n")[0]!;
    expect(header.split(";")).toHaveLength(24);
    expect(header.split(";")[0]).toBe("place_id");
  });

  it("booleans become 1/0", () => {
    // ssl_valid column (index 15 zero-based) is "1" for true.
    const row2 = toCsv([r]).split("\r\n")[1]!;
    const cells = row2.split(";");
    expect(cells[15]).toBe("1");
  });

  it("epoch-ms dates become ISO date (yyyy-mm-dd)", () => {
    const row2 = toCsv([r]).split("\r\n")[1]!;
    const cells = row2.split(";");
    expect(cells[18]).toBe("2026-04-10");
  });

  it("null fields become empty string", () => {
    const r2 = row({ email: null, phone: null });
    const line = toCsv([r2]).split("\r\n")[1]!;
    const cells = line.split(";");
    // email is column index 7, phone index 6.
    expect(cells[6]).toBe("");
    expect(cells[7]).toBe("");
  });

  it('embedded " is doubled and wrapped in quotes', () => {
    const r2 = row({ name: 'He said "hi"' });
    const line = toCsv([r2]).split("\r\n")[1]!;
    // name is index 4. Whole cell wrapped in quotes; inner " doubled.
    const cells = line.split(";");
    expect(cells[4]).toBe('"He said ""hi"""');
  });

  it("semicolon inside a cell triggers quoting", () => {
    const r2 = row({ name: "Foo; Bar" });
    // Split by CRLF (not ;), because ; inside a quoted cell is data.
    const line = toCsv([r2]).split("\r\n")[1]!;
    expect(line).toContain('"Foo; Bar"');
  });
});

describe("toJson — shape invariants", () => {
  it("is valid JSON and roundtrips", () => {
    const out = toJson([row({ place_id: "p1" })]);
    const parsed = JSON.parse(out) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
  });

  it("preserves nulls and booleans as JSON primitives", () => {
    const r = row({
      place_id: "p1",
      ssl_valid: true,
      impressum_complete: null,
      email: null,
      has_social: false,
    });
    const parsed = JSON.parse(toJson([r])) as Array<Record<string, unknown>>;
    expect(parsed[0]!.ssl_valid).toBe(true);
    expect(parsed[0]!.impressum_complete).toBeNull();
    expect(parsed[0]!.email).toBeNull();
    expect(parsed[0]!.has_social).toBe(false);
  });
});

describe("rowToExportShape", () => {
  it("email_is_generic=true when email appears in genericEmails", () => {
    const db = auditRow({
      impressumEmail: "info@example.at",
      genericEmails: ["info@example.at", "office@example.at"],
    });
    const shape = rowToExportShape(db, { warn: () => {} });
    expect(shape.email_is_generic).toBe(true);
  });

  it("email_is_generic=false when email is specific", () => {
    const db = auditRow({
      impressumEmail: "max.mustermann@example.at",
      genericEmails: ["info@example.at"],
    });
    const shape = rowToExportShape(db, { warn: () => {} });
    expect(shape.email_is_generic).toBe(false);
  });

  it("name falls back from hostname when impressum_company_name is null", () => {
    const db = auditRow({
      impressumCompanyName: null,
      discoveredUrl: "https://www.sixta-restaurant.com",
    });
    const shape = rowToExportShape(db, { warn: () => {} });
    expect(shape.name).toBe("Sixta-Restaurant");
  });

  it("hostnameFallback strips www. and title-cases dash-segments", () => {
    expect(hostnameFallback("https://landstein.at")).toBe("Landstein");
    expect(hostnameFallback("https://www.sixta-restaurant.com")).toBe(
      "Sixta-Restaurant",
    );
    expect(hostnameFallback(null)).toBe("");
  });

  it("extractPlzFromAddress accepts valid Vienna PLZ", () => {
    expect(extractPlzFromAddress("Mariahilferstr 1, 1060 Wien")).toBe("1060");
    expect(extractPlzFromAddress("X 1121, AT")).toBeNull();
    expect(extractPlzFromAddress(null)).toBeNull();
  });

  it("mismatch-warn fires with '(unexplained)' when gap != 1", () => {
    const warned: string[] = [];
    const db = auditRow({ score: 99 });
    rowToExportShape(db, { warn: (m) => warned.push(m) });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/stored=99/);
    expect(warned[0]).toMatch(/\(unexplained\)/);
  });

  // Inference-Patch (§K): HAS_STRUCTURED_DATA is not persisted on
  // audit_results, so rebuildScoreInput assumes false. A gap of exactly
  // +1 between recomputed and stored is mathematically unambiguous and
  // gets inferred into the breakdown silently (no warn).
  it("T-Inf-1: gap=1 → HAS_STRUCTURED_DATA injected, breakdown sum == stored", () => {
    const warned: string[] = [];
    // Signals that sum to 8 pre-inference:
    //   NO_SSL +3, NO_HTTPS_REDIRECT +2, NO_ANALYTICS +1,
    //   NO_MODERN_TRACKING +1, NO_SOCIAL_LINKS +1 = 8
    // stored=7 → gap=1 → inference injects HAS_STRUCTURED_DATA -1.
    const db = auditRow({
      sslValid: false,
      httpToHttpsRedirect: false,
      score: 7,
    });
    const shape = rowToExportShape(db, { warn: (m) => warned.push(m) });
    expect(warned).toHaveLength(0);
    const sum = shape.score_breakdown.reduce((s, e) => s + e.delta, 0);
    expect(sum).toBe(7);
    expect(shape.score_breakdown.map((e) => e.key)).toContain(
      "HAS_STRUCTURED_DATA",
    );
  });

  it("T-Inf-2: recomputed == stored → no injection, no warn", () => {
    const warned: string[] = [];
    // Baseline auditRow: analytics/tracking/social all empty → recomputed 3.
    const db = auditRow({ score: 3 });
    const shape = rowToExportShape(db, { warn: (m) => warned.push(m) });
    expect(warned).toHaveLength(0);
    expect(shape.score_breakdown.map((e) => e.key)).not.toContain(
      "HAS_STRUCTURED_DATA",
    );
    const sum = shape.score_breakdown.reduce((s, e) => s + e.delta, 0);
    expect(sum).toBe(3);
  });

  it("T-Inf-3: gap=2 → no injection, warn tagged '(unexplained)'", () => {
    const warned: string[] = [];
    // NO_SSL +3, NO_ANALYTICS +1, NO_MODERN_TRACKING +1, NO_SOCIAL_LINKS +1 = 6
    // but we override techStack so analytics is non-empty → recomputed 5.
    const db = auditRow({
      sslValid: false,
      score: 3,
      techStack: {
        cms: [],
        pageBuilder: [],
        analytics: ["ga"],
        tracking: [],
        payment: [],
        cdn: [],
      },
    });
    const shape = rowToExportShape(db, { warn: (m) => warned.push(m) });
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/\(unexplained\)/);
    expect(shape.score_breakdown.map((e) => e.key)).not.toContain(
      "HAS_STRUCTURED_DATA",
    );
  });
});

describe("rowToExportShape — FIX 3 invariants", () => {
  it("emits score AS STORED — no fallback when null", () => {
    // Under the old rule, score=null would be silently replaced by the
    // recomputed breakdown sum. FIX 3 removes that fallback.
    const db = auditRow({ tier: "C", score: null, intentTier: null });
    const shape = rowToExportShape(db);
    expect(shape.score).toBeNull();
  });

  it("emits score AS STORED — no fallback when non-null but disagreeing", () => {
    // Stored score=99 must come through untouched; the recomputed breakdown
    // sum is for the score_breakdown column only.
    const db = auditRow({ score: 99 });
    const warned: string[] = [];
    const shape = rowToExportShape(db, { warn: (m) => warned.push(m) });
    expect(shape.score).toBe(99);
  });

  it("tier='C' with intent_tier=PARKED and non-null score is allowed", () => {
    const db = auditRow({
      tier: "C",
      intentTier: "PARKED",
      score: 12,
      discoveredUrl: "https://parked.example.at",
    });
    expect(() => rowToExportShape(db)).not.toThrow();
  });

  it("tier='C' with intent_tier=null and null score is allowed (error row)", () => {
    const db = auditRow({ tier: "C", intentTier: null, score: null });
    expect(() => rowToExportShape(db)).not.toThrow();
  });

  it("throws when tier='C' carries intent_tier='LIVE' (not in allowed set)", () => {
    // Give a non-null score so invariant (3) fires, not invariant (2).
    const db = auditRow({
      tier: "C",
      intentTier: "LIVE",
      score: 5,
      placeId: "bad:1",
    });
    expect(() => rowToExportShape(db)).toThrow(/bad:1.*tier='C'.*LIVE/);
  });

  it("throws when tier='C' carries intent_tier='DEAD' (DEAD belongs on B3, not C)", () => {
    const db = auditRow({
      tier: "C",
      intentTier: "DEAD",
      score: 5,
      placeId: "bad:2",
    });
    expect(() => rowToExportShape(db)).toThrow(/bad:2.*DEAD/);
  });

  it("throws when tier='C' with intent_tier=null has non-null score", () => {
    const db = auditRow({
      tier: "C",
      intentTier: null,
      score: 5,
      placeId: "bad:3",
    });
    expect(() => rowToExportShape(db)).toThrow(/bad:3.*score=null/);
  });

  it("throws when intent_tier='LIVE' but score is null (non-error)", () => {
    const db = auditRow({
      tier: "A",
      intentTier: "LIVE",
      score: null,
      placeId: "bad:4",
    });
    expect(() => rowToExportShape(db)).toThrow(/bad:4.*intent_tier=LIVE/);
  });

  it("tier='B3' with intent_tier=DEAD_WEBSITE and score=10 is allowed (FIX 4)", () => {
    const db = auditRow({
      tier: "B3",
      intentTier: "DEAD_WEBSITE",
      score: 10,
      discoveredUrl: null,
    });
    expect(() => rowToExportShape(db)).not.toThrow();
  });

  it("filterRows drops null-score rows regardless of min/max", () => {
    const rows: ExportRow[] = [
      row({ place_id: "ok", score: 10, tier: "A" }),
      row({ place_id: "err", score: null, tier: "C" }),
    ];
    const out = filterRows(rows, defaultFilter({ minScore: 0, maxScore: 30 }));
    expect(out.map((r) => r.place_id)).toEqual(["ok"]);
  });

  it("sortRows puts null-score rows at the bottom", () => {
    const rows: ExportRow[] = [
      row({ place_id: "err", score: null, tier: "C" }),
      row({ place_id: "ok", score: 10, tier: "A" }),
    ];
    const sorted = sortRows(rows);
    expect(sorted.map((r) => r.place_id)).toEqual(["ok", "err"]);
  });
});
