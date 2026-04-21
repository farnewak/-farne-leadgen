import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { readFileSync, rmSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadChainBranchPatterns,
  matchesChainBranch,
  appendFilteredChainBranchLog,
  FILTERED_CHAIN_BRANCHES_CSV_HEADER,
  type ChainBranchPattern,
} from "../../src/pipeline/chain-filter.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const YAML_PATH = resolve(HERE, "../../config/chain_branches.yml");
const TMP_CSV = resolve(HERE, "../tmp/chain-branch-filter.csv");

describe("chain-branch-filter (FIX 5) — pattern matching", () => {
  let patterns: ChainBranchPattern[];

  beforeAll(() => {
    patterns = loadChainBranchPatterns(YAML_PATH);
  });

  it("loads at least the 17 YAML-seeded entries", () => {
    expect(patterns.length).toBeGreaterThanOrEqual(17);
  });

  it("matches a spar.at branch URL", () => {
    const m = matchesChainBranch(
      "https://www.spar.at/standorte/eurospar-wien-1030-landstrasser-hauptstrasse-146",
      patterns,
    );
    expect(m).not.toBeNull();
    expect(m?.chain_name).toBe("Spar");
    expect(m?.matched_pattern).toBe("spar.at/standorte/*");
    expect(m?.reason).toContain("supermarket");
  });

  it("matches an umlaut chain host (ströck.at/filialen/wien-1010)", () => {
    const m = matchesChainBranch(
      "https://ströck.at/filialen/wien-1010-stephansplatz",
      patterns,
    );
    expect(m).not.toBeNull();
    expect(m?.chain_name).toBe("Ströck");
  });

  it("matches the punycode form (xn--strck-lua.at/filialen/wien-1010)", () => {
    const m = matchesChainBranch(
      "https://xn--strck-lua.at/filialen/wien-1010-stephansplatz",
      patterns,
    );
    expect(m).not.toBeNull();
    expect(m?.chain_name).toBe("Ströck");
  });

  it("does NOT match a similar-but-different host (spar-mueller.at/angebot)", () => {
    const m = matchesChainBranch(
      "https://spar-mueller.at/angebot",
      patterns,
    );
    expect(m).toBeNull();
  });

  it("does NOT match plain spar.at/ homepage (apex dedupe's job)", () => {
    const m = matchesChainBranch("https://www.spar.at/", patterns);
    expect(m).toBeNull();
  });
});

describe("chain-branch-filter (FIX 5) — CSV append", () => {
  afterEach(() => {
    try {
      rmSync(TMP_CSV, { force: true });
    } catch {
      // best-effort
    }
  });

  it("creates the CSV with header on first append, no duplicate header on second", () => {
    mkdirSync(dirname(TMP_CSV), { recursive: true });
    appendFilteredChainBranchLog(
      {
        place_id: "p1",
        chain_name: "Spar",
        url: "https://www.spar.at/standorte/a",
        matched_pattern: "spar.at/standorte/*",
        reason: "B2C supermarket chain — branch page",
        filtered_at: new Date("2026-04-21T10:00:00.000Z"),
      },
      TMP_CSV,
    );
    appendFilteredChainBranchLog(
      {
        place_id: "p2",
        chain_name: "Billa",
        url: "https://www.billa.at/filialen/b",
        matched_pattern: "billa.at/filialen/*",
        reason: "B2C supermarket chain — branch page",
        filtered_at: new Date("2026-04-21T10:01:00.000Z"),
      },
      TMP_CSV,
    );
    const contents = readFileSync(TMP_CSV, "utf-8");
    const lines = contents.trim().split("\n");
    expect(lines[0]).toBe(FILTERED_CHAIN_BRANCHES_CSV_HEADER);
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("p1");
    expect(lines[2]).toContain("p2");
  });

  it("auto-creates the parent directory", () => {
    const nested = resolve(HERE, "../tmp/sub/dir/chain.csv");
    try {
      rmSync(dirname(nested), { recursive: true, force: true });
    } catch {
      // best-effort
    }
    appendFilteredChainBranchLog(
      {
        place_id: "p1",
        chain_name: "Spar",
        url: "https://www.spar.at/standorte/a",
        matched_pattern: "spar.at/standorte/*",
        reason: "x",
        filtered_at: new Date("2026-04-21T10:00:00.000Z"),
      },
      nested,
    );
    expect(existsSync(nested)).toBe(true);
    rmSync(resolve(HERE, "../tmp/sub"), { recursive: true, force: true });
  });
});
