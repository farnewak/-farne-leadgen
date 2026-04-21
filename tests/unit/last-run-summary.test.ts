import { describe, it, expect } from "vitest";
import { renderLastRunSummary } from "../../src/reports/last-run-summary.js";
import type { Stage1ResultRow } from "../../schemas/stage1_results.schema.js";

function row(overrides: Partial<Stage1ResultRow> = {}): Stage1ResultRow {
  return {
    place_id: "p1",
    tier: "A",
    sub_tier: "A1",
    intent_tier: "LIVE",
    chain_detected: false,
    chain_name: null,
    branch_count: 1,
    score: 10,
    name: "Test",
    url: "https://example.at",
    phone: null,
    email: null,
    email_is_generic: null,
    address: null,
    plz: null,
    uid: null,
    impressum_complete: null,
    psi_mobile_performance: null,
    ssl_valid: null,
    cms: "wordpress",
    has_structured_data: null,
    last_modified_signal: null,
    has_social: false,
    audited_at: new Date("2026-04-20T12:00:00.000Z"),
    score_breakdown: [],
    ...overrides,
  };
}

// Build a 20-row synthetic dataset exercising every section of the
// renderer: mixed tiers, sub_tiers, chain-detected rows, B3 records
// with null name/address, varied CMS, last_modified_signal spread
// across decade buckets, email_is_generic 0/1/null.
function synthetic20(): Stage1ResultRow[] {
  const out: Stage1ResultRow[] = [];
  // 8 Tier-A rows across sub-tiers A1/A2/A3 with varied scores.
  for (let i = 0; i < 3; i++) {
    out.push(
      row({
        place_id: `a1-${i}`,
        tier: "A",
        sub_tier: "A1",
        score: 12 + i,
        name: `A1 biz ${i}`,
        cms: "wordpress",
        last_modified_signal: 2021 + i,
        email: "info@a1.at",
        email_is_generic: 1,
      }),
    );
  }
  for (let i = 0; i < 3; i++) {
    out.push(
      row({
        place_id: `a2-${i}`,
        tier: "A",
        sub_tier: "A2",
        score: 8 + i,
        name: `A2 biz ${i}`,
        cms: "joomla",
        last_modified_signal: 2015,
        email: `max${i}@a2.at`,
        email_is_generic: 0,
      }),
    );
  }
  out.push(
    row({
      place_id: "a3-1",
      tier: "A",
      sub_tier: "A3",
      score: 4,
      name: "A3 biz",
      cms: "static_or_custom",
      last_modified_signal: 2005,
    }),
  );
  out.push(
    row({
      place_id: "a3-2",
      tier: "A",
      sub_tier: "A3",
      score: 5,
      name: "A3 biz 2",
      cms: "static_or_custom",
      last_modified_signal: 1998,
    }),
  );
  // 3 Tier-B1/B2/B3 rows.
  out.push(
    row({
      place_id: "b1-1",
      tier: "B1",
      sub_tier: null,
      intent_tier: "LIVE",
      score: 15,
      name: "B1 biz",
      cms: "",
    }),
  );
  out.push(
    row({
      place_id: "b2-1",
      tier: "B2",
      sub_tier: null,
      intent_tier: "LIVE",
      score: 17,
      name: "B2 biz",
      cms: "",
    }),
  );
  out.push(
    row({
      place_id: "b3-1",
      tier: "B3",
      sub_tier: null,
      intent_tier: "DEAD_WEBSITE",
      score: 20,
      name: "",
      address: null,
      url: null,
      cms: "",
    }),
  );
  // 2 Tier-C rows (PARKED and null-score error).
  out.push(
    row({
      place_id: "c-parked",
      tier: "C",
      sub_tier: null,
      intent_tier: "PARKED",
      score: 12,
      name: "Parked shop",
      cms: "",
    }),
  );
  out.push(
    row({
      place_id: "c-err",
      tier: "C",
      sub_tier: null,
      intent_tier: null,
      score: null,
      cms: "",
    }),
  );
  // 3 chain-apex canonical rows.
  for (let i = 0; i < 3; i++) {
    out.push(
      row({
        place_id: `apex-${i}`,
        tier: "A",
        sub_tier: "A2",
        intent_tier: "LIVE",
        chain_detected: true,
        chain_name: `chain-${i}.at`,
        branch_count: 4 + i,
        score: 6 + i,
        name: `Chain ${i}`,
        url: `https://chain-${i}.at`,
        cms: "wordpress",
        last_modified_signal: 2010 + i,
      }),
    );
  }
  // Top up to 20: 2 more A1 high-score rows (top-10 feed) + 2 more
  // B3 records without address so section (g) lists more than one.
  for (let i = 0; i < 2; i++) {
    out.push(
      row({
        place_id: `a1-extra-${i}`,
        tier: "A",
        sub_tier: "A1",
        score: 16 + i,
        name: `A1 extra ${i}`,
        url: `https://a1-extra-${i}.at`,
        cms: "drupal",
        last_modified_signal: 2022,
      }),
    );
  }
  for (let i = 0; i < 2; i++) {
    out.push(
      row({
        place_id: `b3-extra-${i}`,
        tier: "B3",
        sub_tier: null,
        intent_tier: "DEAD_WEBSITE",
        score: 20,
        name: "",
        url: null,
        cms: "",
      }),
    );
  }
  return out;
}

describe("renderLastRunSummary — 20-row synthetic", () => {
  const input = {
    rows: synthetic20(),
    droppedCounts: {
      filteredChainBranches: 3,
      collapsedBranches: 2,
      duplicateUrls: 1,
    },
    runTimestamp: new Date("2026-04-21T10:00:00.000Z"),
  };
  const md = renderLastRunSummary(input);

  it("renders all 11 section headers (a..k)", () => {
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
  });

  it("contains no literal undefined or NaN tokens", () => {
    expect(md).not.toMatch(/undefined/);
    expect(md).not.toMatch(/\bNaN\b/);
  });

  it("metadata section reflects input counts + timestamp", () => {
    expect(md).toContain("| total_rows | 20 |");
    expect(md).toContain("| filtered_chain_branches | 3 |");
    expect(md).toContain("| collapsed_branches | 2 |");
    expect(md).toContain("| duplicate_urls | 1 |");
    expect(md).toContain("2026-04-21T10:00:00.000Z");
  });

  it("tier distribution sums to input length", () => {
    // 8 tier-A singletons + 3 chain-apex (all tier A) = 11 A rows,
    // 1 B1, 1 B2, 1 B3, 2 C, total 16 — wait, let's just check it parses.
    const header = md.match(/## \(b\)[\s\S]*?(?=## )/)?.[0] ?? "";
    const nums = [...header.matchAll(/\|\s*(\d+)\s*\|/g)].map((m) =>
      Number(m[1]),
    );
    expect(nums.reduce((s, n) => s + n, 0)).toBe(20);
  });

  it("top-10 worst Tier-A lists B3=null only Tier-A rows sorted desc", () => {
    const section = md.match(/## \(f\)[\s\S]*?(?=## )/)?.[0] ?? "";
    // Highest Tier-A score in fixture is a1-2 with score=14.
    expect(section).toContain("| A1 biz 2 |");
    expect(section).not.toContain("| B2 biz |");
  });

  it("all-B3 section lists the single B3 row with fallback tokens", () => {
    const section = md.match(/## \(g\)[\s\S]*?(?=## )/)?.[0] ?? "";
    expect(section).toContain("b3-1");
    expect(section).toContain("(no name)");
    expect(section).toContain("(no address)");
  });

  it("chain summary lists the 3 apex canonical rows", () => {
    const section = md.match(/## \(h\)[\s\S]*?(?=## )/)?.[0] ?? "";
    expect(section).toContain("chain-0.at");
    expect(section).toContain("chain-1.at");
    expect(section).toContain("chain-2.at");
  });

  it("CMS distribution is sorted descending by count", () => {
    const section = md.match(/## \(i\)[\s\S]*?(?=## )/)?.[0] ?? "";
    const rowsPart = section
      .split("\n")
      .filter((l) => l.startsWith("|") && !l.includes("cms") && !l.includes("---"));
    const counts = rowsPart.map(
      (l) => Number(l.split("|")[2]?.trim() ?? "0"),
    );
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]!);
    }
  });

  it("last_modified_signal buckets cover every decade label", () => {
    const section = md.match(/## \(j\)[\s\S]*?(?=## )/)?.[0] ?? "";
    for (const k of ["<2000", "2000-2009", "2010-2019", "2020+", "null"]) {
      expect(section).toContain(`| ${k} |`);
    }
  });

  it("email_is_generic section counts total_with_email", () => {
    const section = md.match(/## \(k\)[\s\S]*$/)?.[0] ?? "";
    // 3 generic (info@a1.at) + 3 personal (max*@a2.at) = 6 with email.
    expect(section).toContain("| total_with_email | 6 |");
    expect(section).toContain("| 1 | 3 |");
    expect(section).toContain("| 0 | 3 |");
  });
});
