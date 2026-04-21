import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Stage1ResultRow } from "../../schemas/stage1_results.schema.js";

// FIX 14: human-readable run summary. 11 markdown-table sections, zero
// prose. The renderer is pure (input → string); file I/O lives in
// `writeLastRunSummary`. Tests assert presence of every section header
// and reject any literal "undefined" / "NaN" tokens.

export interface RunSummaryInput {
  rows: ReadonlyArray<Stage1ResultRow>;
  droppedCounts: {
    filteredChainBranches: number;
    collapsedBranches: number;
    duplicateUrls: number;
  };
  runTimestamp: Date;
}

export function writeLastRunSummary(
  input: RunSummaryInput,
  outputPath: string,
): void {
  const md = renderLastRunSummary(input);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, md, "utf8");
}

export function renderLastRunSummary(input: RunSummaryInput): string {
  const { rows } = input;
  return [
    sectionMetadata(input),
    sectionTierDistribution(rows),
    sectionSubTierDistribution(rows),
    sectionIntentTierDistribution(rows),
    sectionScorePerSubTier(rows),
    sectionTopWorstTierA(rows),
    sectionAllB3(rows),
    sectionChainSummary(rows),
    sectionCmsDistribution(rows),
    sectionLastModifiedBuckets(rows),
    sectionEmailGenericCounts(rows),
  ].join("\n\n");
}

function sectionMetadata(input: RunSummaryInput): string {
  const { rows, droppedCounts, runTimestamp } = input;
  return [
    "## (a) Run metadata",
    "",
    "| metric | value |",
    "| --- | --- |",
    `| timestamp | ${runTimestamp.toISOString()} |`,
    `| total_rows | ${rows.length} |`,
    `| filtered_chain_branches | ${droppedCounts.filteredChainBranches} |`,
    `| collapsed_branches | ${droppedCounts.collapsedBranches} |`,
    `| duplicate_urls | ${droppedCounts.duplicateUrls} |`,
  ].join("\n");
}

function sectionTierDistribution(rows: ReadonlyArray<Stage1ResultRow>): string {
  const order: Array<Stage1ResultRow["tier"]> = ["A", "B1", "B2", "B3", "C"];
  const counts = new Map<string, number>(order.map((k) => [k, 0]));
  for (const r of rows) counts.set(r.tier, (counts.get(r.tier) ?? 0) + 1);
  const lines = ["## (b) Tier distribution", "", "| tier | count |", "| --- | --- |"];
  for (const k of order) lines.push(`| ${k} | ${counts.get(k) ?? 0} |`);
  return lines.join("\n");
}

function sectionSubTierDistribution(
  rows: ReadonlyArray<Stage1ResultRow>,
): string {
  const order = ["A1", "A2", "A3", "null"] as const;
  const counts = new Map<string, number>(order.map((k) => [k, 0]));
  for (const r of rows) {
    const key = r.sub_tier === null ? "null" : r.sub_tier;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const lines = [
    "## (c) Sub_tier distribution",
    "",
    "| sub_tier | count |",
    "| --- | --- |",
  ];
  for (const k of order) lines.push(`| ${k} | ${counts.get(k) ?? 0} |`);
  return lines.join("\n");
}

function sectionIntentTierDistribution(
  rows: ReadonlyArray<Stage1ResultRow>,
): string {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = r.intent_tier === null ? "null" : r.intent_tier;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const keys = [...counts.keys()].sort();
  const lines = [
    "## (d) Intent_tier distribution",
    "",
    "| intent_tier | count |",
    "| --- | --- |",
  ];
  for (const k of keys) lines.push(`| ${k} | ${counts.get(k) ?? 0} |`);
  if (keys.length === 0) lines.push("| (none) | 0 |");
  return lines.join("\n");
}

function sectionScorePerSubTier(
  rows: ReadonlyArray<Stage1ResultRow>,
): string {
  const order = ["A1", "A2", "A3", "null"] as const;
  const buckets = new Map<string, number[]>(order.map((k) => [k, []]));
  for (const r of rows) {
    if (r.score === null) continue;
    const key = r.sub_tier === null ? "null" : r.sub_tier;
    buckets.get(key)?.push(r.score);
  }
  const lines = [
    "## (e) Score per sub_tier",
    "",
    "| sub_tier | min | p25 | median | p75 | max |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const k of order) {
    const stats = quantiles(buckets.get(k) ?? []);
    lines.push(
      `| ${k} | ${stats.min} | ${stats.p25} | ${stats.median} | ${stats.p75} | ${stats.max} |`,
    );
  }
  return lines.join("\n");
}

function quantiles(values: number[]): {
  min: string;
  p25: string;
  median: string;
  p75: string;
  max: string;
} {
  if (values.length === 0) {
    return { min: "-", p25: "-", median: "-", p75: "-", max: "-" };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q: number): string => {
    const idx = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
    return String(sorted[idx]);
  };
  return {
    min: String(sorted[0]),
    p25: pick(0.25),
    median: pick(0.5),
    p75: pick(0.75),
    max: String(sorted[sorted.length - 1]),
  };
}

function sectionTopWorstTierA(
  rows: ReadonlyArray<Stage1ResultRow>,
): string {
  const tierA = rows
    .filter((r) => r.tier === "A" && r.score !== null)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 10);
  const lines = [
    "## (f) Top-10 worst Tier-A",
    "",
    "| name | url | sub_tier | score | score_breakdown |",
    "| --- | --- | --- | --- | --- |",
  ];
  if (tierA.length === 0) {
    lines.push("| (none) | - | - | - | - |");
    return lines.join("\n");
  }
  for (const r of tierA) {
    const breakdown = truncate(
      JSON.stringify(r.score_breakdown).replace(/\|/g, "/"),
      80,
    );
    const name = mdCell(r.name || "(no name)");
    const url = mdCell(r.url ?? "-");
    const sub = r.sub_tier ?? "null";
    lines.push(`| ${name} | ${url} | ${sub} | ${r.score ?? "-"} | ${breakdown} |`);
  }
  return lines.join("\n");
}

function sectionAllB3(rows: ReadonlyArray<Stage1ResultRow>): string {
  const b3 = rows.filter((r) => r.tier === "B3");
  const lines = [
    "## (g) All B3 records",
    "",
    "| place_id | name | address | score |",
    "| --- | --- | --- | --- |",
  ];
  if (b3.length === 0) {
    lines.push("| (none) | - | - | - |");
    return lines.join("\n");
  }
  for (const r of b3) {
    const name = mdCell(r.name || "(no name)");
    const addr = mdCell(r.address ?? "(no address)");
    lines.push(
      `| ${r.place_id} | ${name} | ${addr} | ${r.score ?? "-"} |`,
    );
  }
  return lines.join("\n");
}

function sectionChainSummary(rows: ReadonlyArray<Stage1ResultRow>): string {
  const chains = rows.filter((r) => r.chain_detected);
  const lines = [
    "## (h) Chain summary",
    "",
    "| chain_name | branch_count | canonical_url | canonical_score |",
    "| --- | --- | --- | --- |",
  ];
  if (chains.length === 0) {
    lines.push("| (none) | - | - | - |");
    return lines.join("\n");
  }
  for (const r of chains) {
    lines.push(
      `| ${mdCell(r.chain_name ?? "-")} | ${r.branch_count} | ${mdCell(r.url ?? "-")} | ${r.score ?? "-"} |`,
    );
  }
  return lines.join("\n");
}

function sectionCmsDistribution(
  rows: ReadonlyArray<Stage1ResultRow>,
): string {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const key = r.cms === "" ? "(empty)" : r.cms;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const lines = [
    "## (i) CMS distribution",
    "",
    "| cms | count |",
    "| --- | --- |",
  ];
  if (sorted.length === 0) {
    lines.push("| (none) | 0 |");
    return lines.join("\n");
  }
  for (const [cms, n] of sorted) lines.push(`| ${mdCell(cms)} | ${n} |`);
  return lines.join("\n");
}

function sectionLastModifiedBuckets(
  rows: ReadonlyArray<Stage1ResultRow>,
): string {
  const order = ["<2000", "2000-2009", "2010-2019", "2020+", "null"] as const;
  const buckets = new Map<string, number>(order.map((k) => [k, 0]));
  const bump = (k: string): void => {
    buckets.set(k, (buckets.get(k) ?? 0) + 1);
  };
  for (const r of rows) {
    const y = r.last_modified_signal;
    if (y === null) bump("null");
    else if (y < 2000) bump("<2000");
    else if (y < 2010) bump("2000-2009");
    else if (y < 2020) bump("2010-2019");
    else bump("2020+");
  }
  const lines = [
    "## (j) last_modified_signal decade buckets",
    "",
    "| bucket | count |",
    "| --- | --- |",
  ];
  for (const k of order) lines.push(`| ${k} | ${buckets.get(k) ?? 0} |`);
  return lines.join("\n");
}

function sectionEmailGenericCounts(
  rows: ReadonlyArray<Stage1ResultRow>,
): string {
  let zero = 0;
  let one = 0;
  let nullC = 0;
  let withEmail = 0;
  for (const r of rows) {
    if (r.email !== null) withEmail += 1;
    if (r.email_is_generic === 0) zero += 1;
    else if (r.email_is_generic === 1) one += 1;
    else nullC += 1;
  }
  return [
    "## (k) email_is_generic counts",
    "",
    "| value | count |",
    "| --- | --- |",
    `| 0 | ${zero} |`,
    `| 1 | ${one} |`,
    `| null | ${nullC} |`,
    `| total_with_email | ${withEmail} |`,
  ].join("\n");
}

// Helpers — markdown cell escape + truncation with ellipsis.
function mdCell(s: string): string {
  return s.replace(/\|/g, "/").replace(/\n/g, " ");
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}
