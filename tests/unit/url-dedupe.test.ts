import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  normalizeUrlForDedupe,
  dedupeByNormalizedUrl,
} from "../../src/pipeline/url-dedupe.js";
import type { UpsertAuditInput } from "../../src/db/audit-cache.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP_LOG_DIR = resolve(HERE, "../tmp/url-dedupe-logs");

// Minimal UpsertAuditInput factory — only the fields the deduper reads.
function row(
  overrides: Partial<UpsertAuditInput> & {
    placeId: string;
    discoveredUrl: string | null;
    score: number | null;
    auditedAt: Date;
  },
): UpsertAuditInput {
  return {
    tier: "A",
    discoveryMethod: "osm-tag",
    sslValid: null,
    sslExpiresAt: null,
    httpToHttpsRedirect: null,
    hasViewportMeta: null,
    viewportMetaContent: null,
    psiMobilePerformance: null,
    psiMobileSeo: null,
    psiMobileAccessibility: null,
    psiMobileBestPractices: null,
    psiFetchedAt: null,
    impressumUrl: null,
    impressumPresent: false,
    impressumUid: null,
    impressumCompanyName: null,
    impressumAddress: null,
    impressumPhone: null,
    impressumEmail: null,
    impressumComplete: null,
    techStack: {
      cms: [],
      pageBuilder: [],
      analytics: [],
      tracking: [],
      payment: [],
      cdn: [],
    },
    genericEmails: [],
    socialLinks: {},
    fetchError: null,
    fetchErrorAt: null,
    intentTier: null,
    staticSignalsExpiresAt: new Date(overrides.auditedAt.getTime() + 86_400_000),
    psiSignalsExpiresAt: null,
    chainDetected: false,
    chainName: null,
    branchCount: 1,
    lastModifiedSignal: null,
    hasStructuredData: null,
    ...overrides,
  } as UpsertAuditInput;
}

describe("normalizeUrlForDedupe", () => {
  it("lowercases host", () => {
    expect(normalizeUrlForDedupe("https://Example.AT/foo")).toBe(
      "https://example.at/foo",
    );
  });

  it("strips leading www.", () => {
    expect(normalizeUrlForDedupe("https://www.example.at/foo")).toBe(
      "https://example.at/foo",
    );
  });

  it("strips trailing slash from path", () => {
    expect(normalizeUrlForDedupe("https://example.at/foo/")).toBe(
      "https://example.at/foo",
    );
  });

  it("leaves root / as empty path", () => {
    expect(normalizeUrlForDedupe("https://example.at/")).toBe(
      "https://example.at",
    );
  });

  it("removes utm_ params", () => {
    expect(
      normalizeUrlForDedupe(
        "https://example.at/foo?utm_source=nl&utm_medium=email&keep=1",
      ),
    ).toBe("https://example.at/foo?keep=1");
  });

  it("removes specific tracking params", () => {
    const cases = [
      "gclid=abc",
      "fbclid=abc",
      "mc_eid=abc",
      "mc_cid=abc",
      "yclid=abc",
      "_hsenc=abc",
      "_hsmi=abc",
    ];
    for (const qs of cases) {
      expect(
        normalizeUrlForDedupe(`https://example.at/foo?${qs}&keep=1`),
      ).toBe("https://example.at/foo?keep=1");
    }
  });

  it("drops fragment", () => {
    expect(normalizeUrlForDedupe("https://example.at/foo#bar")).toBe(
      "https://example.at/foo",
    );
  });

  it("punycodes IDN hosts", () => {
    // ströck.at → xn--strck-lua.at
    expect(normalizeUrlForDedupe("https://ströck.at/angebot")).toBe(
      "https://xn--strck-lua.at/angebot",
    );
    // Already-punycoded stays stable (host is ASCII → passes through).
    expect(normalizeUrlForDedupe("https://xn--strck-lua.at/angebot")).toBe(
      "https://xn--strck-lua.at/angebot",
    );
  });

  it("preserves non-utm query params in stable order", () => {
    const out = normalizeUrlForDedupe(
      "https://example.at/foo?b=2&a=1&utm_source=x",
    );
    // URL params come back in insertion order (non-UTM only).
    expect(out).toBe("https://example.at/foo?b=2&a=1");
  });

  it("returns null for invalid URLs", () => {
    expect(normalizeUrlForDedupe("not a url")).toBe(null);
    expect(normalizeUrlForDedupe("")).toBe(null);
  });
});

describe("dedupeByNormalizedUrl", () => {
  beforeEach(() => {
    try {
      rmSync(TMP_LOG_DIR, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    mkdirSync(TMP_LOG_DIR, { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(TMP_LOG_DIR, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it("keeps higher-score row when two rows share a URL", () => {
    const a = row({
      placeId: "p-a",
      discoveredUrl: "https://example.at/x",
      score: 8,
      auditedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    const b = row({
      placeId: "p-b",
      discoveredUrl: "https://www.example.at/x/",
      score: 14,
      auditedAt: new Date("2026-04-02T00:00:00.000Z"),
    });
    const res = dedupeByNormalizedUrl([a, b], { logDir: TMP_LOG_DIR });
    expect(res.survivors.map((r) => r.placeId)).toEqual(["p-b"]);
    expect(res.droppedCount).toBe(1);
  });

  it("keeps earlier audited_at when scores tie", () => {
    const earlier = row({
      placeId: "p-early",
      discoveredUrl: "https://example.at/x",
      score: 10,
      auditedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    const later = row({
      placeId: "p-late",
      discoveredUrl: "https://example.at/x",
      score: 10,
      auditedAt: new Date("2026-04-05T00:00:00.000Z"),
    });
    const res = dedupeByNormalizedUrl([earlier, later], {
      logDir: TMP_LOG_DIR,
    });
    expect(res.survivors.map((r) => r.placeId)).toEqual(["p-early"]);
  });

  it("three-way dedupe → one survivor, two logged", () => {
    const a = row({
      placeId: "p1",
      discoveredUrl: "https://example.at/x",
      score: 5,
      auditedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    const b = row({
      placeId: "p2",
      discoveredUrl: "https://example.at/x?utm_source=nl",
      score: 9,
      auditedAt: new Date("2026-04-02T00:00:00.000Z"),
    });
    const c = row({
      placeId: "p3",
      discoveredUrl: "https://www.example.at/x/#anchor",
      score: 7,
      auditedAt: new Date("2026-04-03T00:00:00.000Z"),
    });
    const res = dedupeByNormalizedUrl([a, b, c], { logDir: TMP_LOG_DIR });
    expect(res.survivors.map((r) => r.placeId)).toEqual(["p2"]);
    expect(res.droppedCount).toBe(2);
    const csvPath = resolve(TMP_LOG_DIR, "duplicate_urls.csv");
    expect(existsSync(csvPath)).toBe(true);
    const csv = readFileSync(csvPath, "utf-8");
    const lines = csv.trim().split("\n");
    expect(lines[0]).toBe(
      "kept_place_id,dropped_place_id,normalized_url,kept_score,dropped_score,duplicate_reason,filtered_at",
    );
    // Two drop entries.
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("p2");
    expect(lines[1]).toContain("https://example.at/x");
    expect(lines[2]).toContain("p2");
  });

  it("IDN dedupe: ströck.at/angebot === xn--strck-lua.at/angebot", () => {
    const a = row({
      placeId: "p-idn",
      discoveredUrl: "https://ströck.at/angebot",
      score: 8,
      auditedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    const b = row({
      placeId: "p-ascii",
      discoveredUrl: "https://xn--strck-lua.at/angebot",
      score: 12,
      auditedAt: new Date("2026-04-02T00:00:00.000Z"),
    });
    const res = dedupeByNormalizedUrl([a, b], { logDir: TMP_LOG_DIR });
    expect(res.survivors.map((r) => r.placeId)).toEqual(["p-ascii"]);
  });

  it("null-URL rows pass through untouched (never dedupe on null)", () => {
    const a = row({
      placeId: "p-null-1",
      discoveredUrl: null,
      score: 20,
      auditedAt: new Date("2026-04-01T00:00:00.000Z"),
      tier: "B3",
    });
    const b = row({
      placeId: "p-null-2",
      discoveredUrl: null,
      score: 20,
      auditedAt: new Date("2026-04-02T00:00:00.000Z"),
      tier: "B3",
    });
    const c = row({
      placeId: "p-url",
      discoveredUrl: "https://example.at/",
      score: 8,
      auditedAt: new Date("2026-04-03T00:00:00.000Z"),
    });
    const res = dedupeByNormalizedUrl([a, b, c], { logDir: TMP_LOG_DIR });
    expect(res.survivors.map((r) => r.placeId).sort()).toEqual([
      "p-null-1",
      "p-null-2",
      "p-url",
    ]);
    expect(res.droppedCount).toBe(0);
  });

  it("null-score row loses against scored row on same URL", () => {
    const a = row({
      placeId: "p-null-score",
      discoveredUrl: "https://example.at/x",
      score: null,
      auditedAt: new Date("2026-04-01T00:00:00.000Z"),
    });
    const b = row({
      placeId: "p-scored",
      discoveredUrl: "https://example.at/x",
      score: 3,
      auditedAt: new Date("2026-04-02T00:00:00.000Z"),
    });
    const res = dedupeByNormalizedUrl([a, b], { logDir: TMP_LOG_DIR });
    expect(res.survivors.map((r) => r.placeId)).toEqual(["p-scored"]);
  });
});
