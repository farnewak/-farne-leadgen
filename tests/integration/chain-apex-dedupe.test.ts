import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  dedupeChainApices,
  extractApex,
} from "../../src/pipeline/chain-apex-dedupe.js";
import { rowToExportShape } from "../../src/pipeline/export.js";
import type { UpsertAuditInput } from "../../src/db/audit-cache.js";
import type { AuditResult } from "../../src/db/schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TMP_LOG_DIR = resolve(HERE, "../tmp/chain-apex-dedupe-logs");
const FIXED_NOW = new Date("2026-04-20T12:00:00.000Z");

const EMPTY_TECH = {
  cms: [],
  pageBuilder: [],
  analytics: [],
  tracking: [],
  payment: [],
  cdn: [],
};

// Build an UpsertAuditInput for a Tier-A branch. Keeps tests terse —
// only the dedupe-relevant fields (placeId, discoveredUrl, tier, score,
// chain_*) need per-test control.
function branchRow(
  placeId: string,
  discoveredUrl: string,
  score: number | null = 12,
): UpsertAuditInput {
  return {
    placeId,
    auditedAt: FIXED_NOW,
    tier: "A",
    discoveredUrl,
    discoveryMethod: "osm-tag",
    sslValid: true,
    sslExpiresAt: null,
    httpToHttpsRedirect: true,
    hasViewportMeta: true,
    viewportMetaContent: null,
    psiMobilePerformance: 60,
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
    techStack: EMPTY_TECH,
    genericEmails: [],
    socialLinks: {},
    fetchError: null,
    fetchErrorAt: null,
    intentTier: "LIVE",
    staticSignalsExpiresAt: new Date("2026-05-20T12:00:00.000Z"),
    psiSignalsExpiresAt: null,
    score,
    chainDetected: false,
    chainName: null,
    branchCount: 1,
    lastModifiedSignal: null,
    hasStructuredData: false,
  };
}

// Apex audit fixture: returns a full UpsertAuditInput with a specific
// score. Dedupe decides drop (clean) vs. collapse (bad) on this score.
function apexAudit(apex: string, score: number | null): UpsertAuditInput {
  return {
    ...branchRow(`apex:${apex}`, `https://${apex}/`, score),
  };
}

describe("extractApex", () => {
  it("returns eTLD+1 for normal URLs", () => {
    expect(extractApex("https://shop.kleingewerbe-wien.at/filiale-mitte")).toBe(
      "kleingewerbe-wien.at",
    );
    expect(extractApex("https://www.spar.at/standorte/x")).toBe("spar.at");
  });

  it("returns null for raw-IP URLs (tldts cannot parse)", () => {
    expect(extractApex("http://192.168.1.1/")).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(extractApex("not a url")).toBeNull();
  });
});

describe("dedupeChainApices", () => {
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

  // Variant A: bad apex (score >= 5) → collapse the group to one canonical
  // row. R5 singleton is not touched, raw-IP row passes through, and the
  // logs/collapsed_branches.csv gets one line per branch.
  it(
    "collapses bad-apex group (score>=5) into one canonical row, " +
      "singleton passes through, raw-IP passes through",
    async () => {
      const r4a = branchRow(
        "osm:node:100000004",
        "https://shop.kleingewerbe-wien.at/filiale-mitte",
      );
      const r4b = branchRow(
        "osm:node:100000005",
        "https://blog.kleingewerbe-wien.at/filiale-ost",
      );
      const r4c = branchRow(
        "osm:node:100000006",
        "https://www.kleingewerbe-wien.at/filiale-sued",
      );
      const r5 = branchRow("osm:node:100000007", "https://einzelkaempfer.at/");
      const rawIp = branchRow("osm:node:100000008", "http://192.168.1.1/");

      let apexCalls = 0;
      const result = await dedupeChainApices([r4a, r4b, r4c, r5, rawIp], {
        auditApex: async (apex) => {
          apexCalls += 1;
          // Sanity-check the apex key — R5's and raw-IP's apex must NEVER
          // be audited (singleton resp. null-apex pass-through).
          expect(apex).toBe("kleingewerbe-wien.at");
          return apexAudit(apex, 12);
        },
        logDir: TMP_LOG_DIR,
        now: () => FIXED_NOW,
      });

      expect(apexCalls).toBe(1);
      expect(result.collapsedGroups).toBe(1);
      expect(result.collapsedBranches).toBe(3);
      expect(result.droppedBranches).toBe(0);

      // Survivors: one canonical chain row + R5 + raw-IP.
      expect(result.survivors).toHaveLength(3);
      const chainRow = result.survivors.find((r) => r.chainDetected === true);
      expect(chainRow).toBeDefined();
      expect(chainRow!.chainName).toBe("kleingewerbe-wien.at");
      expect(chainRow!.branchCount).toBe(3);
      expect(chainRow!.discoveredUrl).toBe("https://kleingewerbe-wien.at/");

      const singleton = result.survivors.find(
        (r) => r.placeId === "osm:node:100000007",
      );
      expect(singleton).toBeDefined();
      expect(singleton!.chainDetected).toBe(false);
      expect(singleton!.chainName).toBeNull();
      expect(singleton!.branchCount).toBe(1);

      const rawPass = result.survivors.find(
        (r) => r.placeId === "osm:node:100000008",
      );
      expect(rawPass).toBeDefined();

      const csvPath = resolve(TMP_LOG_DIR, "collapsed_branches.csv");
      expect(existsSync(csvPath)).toBe(true);
      const lines = readFileSync(csvPath, "utf-8").trim().split("\n");
      expect(lines[0]).toBe(
        "apex,chain_name,branch_place_id,branch_url,branch_score,collapsed_at",
      );
      expect(lines).toHaveLength(4);
      for (const branchId of [
        "osm:node:100000004",
        "osm:node:100000005",
        "osm:node:100000006",
      ]) {
        expect(lines.some((l) => l.includes(branchId))).toBe(true);
      }
    },
  );

  // Variant B: clean apex (score < 5) → drop all branches, log each to
  // filtered_chain_branches.csv with the apex-dedupe-specific reason.
  it("drops clean-apex group (score<5) and logs branches to filtered CSV", async () => {
    const r4a = branchRow(
      "osm:node:100000004",
      "https://shop.kleingewerbe-wien.at/filiale-mitte",
    );
    const r4b = branchRow(
      "osm:node:100000005",
      "https://blog.kleingewerbe-wien.at/filiale-ost",
    );
    const r4c = branchRow(
      "osm:node:100000006",
      "https://www.kleingewerbe-wien.at/filiale-sued",
    );

    const result = await dedupeChainApices([r4a, r4b, r4c], {
      auditApex: async (apex) => apexAudit(apex, 2),
      logDir: TMP_LOG_DIR,
      now: () => FIXED_NOW,
    });

    expect(result.droppedBranches).toBe(3);
    expect(result.collapsedGroups).toBe(0);
    expect(result.survivors).toHaveLength(0);

    const csvPath = resolve(TMP_LOG_DIR, "filtered_chain_branches.csv");
    expect(existsSync(csvPath)).toBe(true);
    const lines = readFileSync(csvPath, "utf-8").trim().split("\n");
    // Header + 3 branch rows.
    expect(lines).toHaveLength(4);
    for (const branchId of [
      "osm:node:100000004",
      "osm:node:100000005",
      "osm:node:100000006",
    ]) {
      const hit = lines.find((l) => l.includes(branchId));
      expect(hit).toBeDefined();
      expect(hit).toContain("good_apex_branch");
      expect(hit).toContain("<apex-dedupe>");
    }
  });

  it("skips apex audit entirely when group has only one row (singleton)", async () => {
    const r5 = branchRow("osm:node:100000007", "https://einzelkaempfer.at/");
    let called = false;
    const result = await dedupeChainApices([r5], {
      auditApex: async () => {
        called = true;
        return apexAudit("einzelkaempfer.at", 12);
      },
      logDir: TMP_LOG_DIR,
      now: () => FIXED_NOW,
    });
    expect(called).toBe(false);
    expect(result.survivors).toHaveLength(1);
    expect(result.survivors[0]!.placeId).toBe("osm:node:100000007");
  });

  it("passes failed apex audit (null) branches through untouched", async () => {
    const r4a = branchRow(
      "osm:node:100000004",
      "https://shop.kleingewerbe-wien.at/filiale-mitte",
    );
    const r4b = branchRow(
      "osm:node:100000005",
      "https://blog.kleingewerbe-wien.at/filiale-ost",
    );

    const result = await dedupeChainApices([r4a, r4b], {
      auditApex: async () => null,
      logDir: TMP_LOG_DIR,
      now: () => FIXED_NOW,
    });

    expect(result.droppedBranches).toBe(0);
    expect(result.collapsedGroups).toBe(0);
    expect(result.survivors).toHaveLength(2);
  });

  // Invariant: a hand-forged row with chain_detected=true but chain_name
  // null must throw at export time with the row's placeId in the message.
  it("export invariant throws when chain_detected=true and chain_name=null", () => {
    const bad: AuditResult = {
      id: 42,
      placeId: "forged:1",
      auditedAt: FIXED_NOW,
      tier: "A",
      discoveredUrl: "https://example.at/",
      discoveryMethod: "osm-tag",
      sslValid: true,
      sslExpiresAt: null,
      httpToHttpsRedirect: true,
      hasViewportMeta: true,
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
      techStack: EMPTY_TECH,
      genericEmails: [],
      socialLinks: {},
      fetchError: null,
      fetchErrorAt: null,
      intentTier: "LIVE",
      staticSignalsExpiresAt: FIXED_NOW,
      psiSignalsExpiresAt: null,
      score: 10,
      chainDetected: true,
      chainName: null,
      branchCount: 3,
      lastModifiedSignal: null,
      hasStructuredData: false,
    };
    expect(() => rowToExportShape(bad, { warn: () => {} })).toThrow(
      /forged:1.*chain_detected=true.*chain_name is null/,
    );
  });

  it("export invariant throws when chain_detected=false but branch_count=3", () => {
    const bad: AuditResult = {
      id: 43,
      placeId: "forged:2",
      auditedAt: FIXED_NOW,
      tier: "A",
      discoveredUrl: "https://example.at/",
      discoveryMethod: "osm-tag",
      sslValid: true,
      sslExpiresAt: null,
      httpToHttpsRedirect: true,
      hasViewportMeta: true,
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
      techStack: EMPTY_TECH,
      genericEmails: [],
      socialLinks: {},
      fetchError: null,
      fetchErrorAt: null,
      intentTier: "LIVE",
      staticSignalsExpiresAt: FIXED_NOW,
      psiSignalsExpiresAt: null,
      score: 10,
      chainDetected: false,
      chainName: null,
      branchCount: 3,
      lastModifiedSignal: null,
      hasStructuredData: false,
    };
    expect(() => rowToExportShape(bad, { warn: () => {} })).toThrow(
      /forged:2.*branch_count=3/,
    );
  });
});
