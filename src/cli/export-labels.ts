import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  findAuditByPlaceId,
  listOutcomes,
} from "../db/lead-outcomes.js";
import type { AuditResult, LeadOutcome } from "../db/schema.js";
import { getArg, getBoolArg } from "./args.js";

const HELP = `\
leadgen export-labels — emit JSONL of every collected label joined with
its audit_results snapshot, ready for ML-notebook ingestion.

Usage:
  leadgen export-labels [--output <path>]

Options:
  --output <path>        Output file. When omitted, JSONL streams to stdout.
  --help                 Show this help and exit 0.

Schema per line:
  { "lead_id", "status", "channel", "notes", "created_at",
    "score", "features": { <audit_results snapshot> } }

Features are read as-stored (spec §C I7) — no signals are re-evaluated.
Labels for leads without an audit row are skipped (logged to stderr).
`;

// Whitelist of audit_results fields promoted to the features object. Admin
// columns (ids, expiry timestamps, fetch errors) stay out — they are plumbing,
// not training signal. Kept narrow on purpose so the JSONL schema is stable
// across audit_results migrations.
const FEATURE_KEYS = [
  "tier",
  "discoveredUrl",
  "discoveryMethod",
  "sslValid",
  "httpToHttpsRedirect",
  "hasViewportMeta",
  "viewportMetaContent",
  "psiMobilePerformance",
  "psiMobileSeo",
  "psiMobileAccessibility",
  "psiMobileBestPractices",
  "impressumUrl",
  "impressumPresent",
  "impressumUid",
  "impressumCompanyName",
  "impressumAddress",
  "impressumPhone",
  "impressumEmail",
  "impressumComplete",
  "techStack",
  "genericEmails",
  "socialLinks",
  "intentTier",
  "lastModifiedSignal",
  "hasStructuredData",
] as const satisfies readonly (keyof AuditResult)[];

export interface LabelExportLine {
  lead_id: string;
  status: string;
  channel: string | null;
  notes: string | null;
  created_at: number;
  score: number | null;
  features: Partial<Record<(typeof FEATURE_KEYS)[number], unknown>>;
}

// Serialises a Date-typed column to its epoch-millis form. audit_results
// uses Date objects in Drizzle but the ML side expects JSON-safe primitives.
function normalizeValue(v: unknown): unknown {
  if (v instanceof Date) return v.getTime();
  return v;
}

export function buildFeatureSnapshot(
  row: AuditResult,
): LabelExportLine["features"] {
  const out: LabelExportLine["features"] = {};
  for (const key of FEATURE_KEYS) {
    out[key] = normalizeValue(row[key]);
  }
  return out;
}

export function buildLine(
  outcome: LeadOutcome,
  audit: AuditResult | null,
): LabelExportLine {
  return {
    lead_id: outcome.leadId,
    status: outcome.status,
    channel: outcome.channel,
    notes: outcome.notes,
    created_at: outcome.createdAt,
    score: audit?.score ?? null,
    features: audit ? buildFeatureSnapshot(audit) : {},
  };
}

export async function collectLabelLines(): Promise<LabelExportLine[]> {
  const outcomes = await listOutcomes();
  const out: LabelExportLine[] = [];
  // Cache audit lookups: label CSVs tend to reference the same lead_id
  // multiple times (multi-touchpoint leads), and re-querying per row
  // turns a 100-label export into 100 DB round-trips for nothing.
  const cache = new Map<string, AuditResult | null>();
  for (const o of outcomes) {
    let audit = cache.get(o.leadId);
    if (audit === undefined) {
      audit = await findAuditByPlaceId(o.leadId);
      cache.set(o.leadId, audit);
    }
    if (!audit) {
      process.stderr.write(
        `[export-labels] WARN: no audit_results row for lead_id=${o.leadId}; emitting with empty features\n`,
      );
    }
    out.push(buildLine(o, audit));
  }
  return out;
}

export function toJsonl(lines: readonly LabelExportLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length > 0 ? "\n" : "");
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  const args = argv[0] === "export-labels" ? argv.slice(1) : argv;
  if (getBoolArg("--help", args)) {
    process.stdout.write(HELP);
    return;
  }
  const outputRaw = getArg("--output", args);
  const lines = await collectLabelLines();
  const body = toJsonl(lines);

  if (outputRaw && outputRaw.length > 0) {
    const abs = resolve(process.cwd(), outputRaw);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body, "utf8");
    process.stdout.write(
      `wrote ${lines.length} labels to ${outputRaw}\n`,
    );
    return;
  }
  process.stdout.write(body);
}
