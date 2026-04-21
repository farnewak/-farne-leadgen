import { getDomain } from "tldts";
import type { UpsertAuditInput } from "../db/audit-cache.js";
import { appendFilteredChainBranchLog } from "./chain-filter.js";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// FIX 6 — chain-apex dedupe. Runs AFTER the per-row chain-branch filter
// (FIX 5) and BEFORE DB upsert. Groups surviving Tier-A rows by eTLD+1
// apex; each group with >= 2 rows triggers ONE synthetic audit against
// https://<apex>/ and is then either dropped wholesale (clean apex, all
// branches are likely legit local sites whose apex is a happy corporate
// homepage — they would swamp outreach) or COLLAPSED into one canonical
// row whose body is the apex audit and whose chain_detected/chain_name/
// branch_count fields are set.
//
// The call site injects the apex audit function so production callers
// pass `auditOne` and tests pass a mock. Apex audits are memoised per
// apex so multiple groups sharing one apex don't re-probe.

export interface ChainApexDedupeOptions {
  // Runs a synthetic audit against a `https://<apex>/` URL. Returns an
  // UpsertAuditInput whose `score` is inspected for the drop-vs-collapse
  // decision (threshold 5 — see BAD_APEX_SCORE_THRESHOLD). Return null
  // to treat the apex audit as failed; rows pass through untouched.
  auditApex: (apex: string) => Promise<UpsertAuditInput | null>;
  // Directory where logs/filtered_chain_branches.csv and
  // logs/collapsed_branches.csv live. Tests redirect to a tmp dir.
  logDir: string;
  // Injectable clock for deterministic tests.
  now?: () => Date;
}

export interface ChainApexDedupeResult {
  survivors: UpsertAuditInput[];
  // Diagnostic counts. Enables assertions that don't need to parse the
  // CSV files in integration tests.
  droppedBranches: number;
  collapsedGroups: number;
  collapsedBranches: number;
}

export const BAD_APEX_SCORE_THRESHOLD = 5;

const COLLAPSED_CSV_HEADER =
  "apex,chain_name,branch_place_id,branch_url,branch_score,collapsed_at";

// tldts returns null for raw-IP hosts and unparseable URLs. Callers let
// those rows pass through untouched (there's no grouping to do anyway).
export function extractApex(url: string): string | null {
  const d = getDomain(url);
  if (!d) return null;
  return d.toLowerCase();
}

function csvEscape(v: string): string {
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function appendCollapsedBranchLog(
  entry: {
    apex: string;
    chain_name: string;
    branch_place_id: string;
    branch_url: string;
    branch_score: number | null;
    collapsed_at: Date;
  },
  csvPath: string,
): void {
  const dir = dirname(csvPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const needsHeader = !existsSync(csvPath);
  const line = [
    entry.apex,
    entry.chain_name,
    entry.branch_place_id,
    entry.branch_url,
    entry.branch_score === null ? "" : String(entry.branch_score),
    entry.collapsed_at.toISOString(),
  ]
    .map(csvEscape)
    .join(",");
  const body = needsHeader ? `${COLLAPSED_CSV_HEADER}\n${line}\n` : `${line}\n`;
  appendFileSync(csvPath, body, "utf-8");
}

// Groups Tier-A rows by apex; returns both the groups and the set of
// "pass-through" rows (non-A tier, null URL, or apex-extraction failure).
interface GroupingResult {
  groups: Map<string, UpsertAuditInput[]>;
  passThrough: UpsertAuditInput[];
}

function groupByApex(rows: UpsertAuditInput[]): GroupingResult {
  const groups = new Map<string, UpsertAuditInput[]>();
  const passThrough: UpsertAuditInput[] = [];
  for (const row of rows) {
    if (row.tier !== "A" || row.discoveredUrl === null) {
      passThrough.push(row);
      continue;
    }
    const apex = extractApex(row.discoveredUrl);
    if (apex === null) {
      passThrough.push(row);
      continue;
    }
    const bucket = groups.get(apex);
    if (bucket) bucket.push(row);
    else groups.set(apex, [row]);
  }
  return { groups, passThrough };
}

// Main entry. For each apex group with size >= 2: audit the apex once
// (memoised), decide drop-vs-collapse by score threshold, log the
// affected rows to the appropriate CSV, and either drop the branches
// (clean apex) or emit a single collapsed canonical row (bad apex).
// Singletons pass straight through.
export async function dedupeChainApices(
  rows: UpsertAuditInput[],
  options: ChainApexDedupeOptions,
): Promise<ChainApexDedupeResult> {
  const now = options.now ?? (() => new Date());
  const filteredCsv = resolve(options.logDir, "filtered_chain_branches.csv");
  const collapsedCsv = resolve(options.logDir, "collapsed_branches.csv");
  const { groups, passThrough } = groupByApex(rows);

  const survivors: UpsertAuditInput[] = [...passThrough];
  // Singletons: re-add as-is, no audit needed.
  for (const [, group] of groups) {
    if (group.length < 2) survivors.push(...group);
  }

  let droppedBranches = 0;
  let collapsedGroups = 0;
  let collapsedBranches = 0;

  const apexAuditMemo = new Map<string, UpsertAuditInput | null>();

  for (const [apex, group] of groups) {
    if (group.length < 2) continue;
    let apexAudit: UpsertAuditInput | null;
    if (apexAuditMemo.has(apex)) {
      apexAudit = apexAuditMemo.get(apex) ?? null;
    } else {
      apexAudit = await options.auditApex(apex);
      apexAuditMemo.set(apex, apexAudit);
    }

    // If the apex audit failed outright, pass the branches through
    // rather than guessing. This mirrors how the per-row chain-filter
    // handles missing config (log-and-continue, don't drop the data).
    if (apexAudit === null) {
      survivors.push(...group);
      continue;
    }

    const apexScore = apexAudit.score;
    // Clean apex (score < threshold) → drop all branches. Each branch
    // is logged to filtered_chain_branches.csv with a distinct reason
    // so post-hoc analysis can separate FIX-5 hits from FIX-6 hits.
    if (apexScore !== null && apexScore < BAD_APEX_SCORE_THRESHOLD) {
      for (const branch of group) {
        appendFilteredChainBranchLog(
          {
            place_id: branch.placeId,
            chain_name: apex,
            url: branch.discoveredUrl ?? "",
            matched_pattern: "<apex-dedupe>",
            reason: `good_apex_branch — parent site scored ${apexScore}`,
            filtered_at: now(),
          },
          filteredCsv,
        );
      }
      droppedBranches += group.length;
      continue;
    }

    // Bad apex (score >= threshold, or null-score which we treat as
    // "could not confirm clean"): collapse. One canonical row uses the
    // apex audit body; the three chain-* columns are overwritten to
    // carry the apex metadata. Each branch is archived to
    // collapsed_branches.csv so the mapping from branch place_id to
    // apex is never lost.
    const canonical: UpsertAuditInput = {
      ...apexAudit,
      chainDetected: true,
      chainName: apex,
      branchCount: group.length,
    };
    survivors.push(canonical);
    for (const branch of group) {
      appendCollapsedBranchLog(
        {
          apex,
          chain_name: apex,
          branch_place_id: branch.placeId,
          branch_url: branch.discoveredUrl ?? "",
          branch_score: branch.score,
          collapsed_at: now(),
        },
        collapsedCsv,
      );
    }
    collapsedGroups += 1;
    collapsedBranches += group.length;
  }

  return {
    survivors,
    droppedBranches,
    collapsedGroups,
    collapsedBranches,
  };
}

export const COLLAPSED_BRANCHES_CSV_HEADER = COLLAPSED_CSV_HEADER;
