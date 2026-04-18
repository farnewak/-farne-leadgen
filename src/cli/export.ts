import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { queryAuditResultsForExport } from "../db/export-queries.js";
import {
  filterRows,
  rowToExportShape,
  toCsv,
  toJson,
  type ExportFilterOptions,
  type ExportRow,
} from "../pipeline/export.js";
import { TIERS, type Tier } from "../models/audit.js";
import {
  getArg,
  getBoolArg,
  getNumberArg,
  getRepeatableArg,
} from "./args.js";

export type ExportFormat = "csv" | "json";

export interface ExportCliOptions {
  output: string;
  tiers: Tier[] | null;
  plzList: string[] | null;
  minScore: number;
  maxScore: number;
  limit: number | null;
  format: ExportFormat;
}

const HELP = `\
leadgen export — write audited leads to CSV or JSON.

Usage:
  leadgen export [options]

Options:
  --output <path>        Output file. Default: runs/leads-<date>.(csv|json)
  --tier <T>             Filter by tier (repeatable). Allowed: ${TIERS.join(",")}.
                         Omit for all tiers.
  --plz 1010,1020        Comma-separated Vienna PLZs. Omit for all.
  --min-score N          Minimum score (inclusive). Default: 0.
  --max-score N          Maximum score (inclusive). Default: 30.
  --limit N              Cap row count after sort. Default: no cap.
  --format csv|json      Output format. Default: csv.
  --help                 Show this help and exit 0.

Sort order is fixed: score DESC, audited_at DESC.
CSV is UTF-8 with BOM + CRLF + ; separator (EU-Excel compatible).
`;

function isoDate(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function parseExportArgs(argv: string[]): ExportCliOptions {
  const format = (getArg("--format", argv) ?? "csv") as ExportFormat;
  if (format !== "csv" && format !== "json") {
    throw new Error(`invalid --format: ${format} (allowed: csv|json)`);
  }

  const outputRaw = getArg("--output", argv);
  const output =
    outputRaw && outputRaw.length > 0
      ? outputRaw
      : `runs/leads-${isoDate()}.${format}`;

  const tierRaw = getRepeatableArg("--tier", argv);
  for (const t of tierRaw) {
    if (!TIERS.includes(t as Tier)) {
      throw new Error(`invalid --tier: ${t} (allowed: ${TIERS.join(",")})`);
    }
  }
  const tiers = tierRaw.length > 0 ? (tierRaw as Tier[]) : null;

  const plzRaw = getArg("--plz", argv);
  const plzList =
    plzRaw && plzRaw.length > 0
      ? plzRaw
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0)
      : null;

  const minScore = getNumberArg("--min-score", argv) ?? 0;
  const maxScore = getNumberArg("--max-score", argv) ?? 30;
  const limit = getNumberArg("--limit", argv);

  return { output, tiers, plzList, minScore, maxScore, limit, format };
}

function toFilterOptions(opts: ExportCliOptions): ExportFilterOptions {
  return {
    tiers: opts.tiers,
    plzList: opts.plzList,
    minScore: opts.minScore,
    maxScore: opts.maxScore,
    limit: opts.limit,
  };
}

export async function runExport(opts: ExportCliOptions): Promise<number> {
  const dbRows = await queryAuditResultsForExport({
    tiers: opts.tiers,
    minScore: opts.minScore,
    maxScore: opts.maxScore,
  });
  const shaped: ExportRow[] = dbRows.map((r) => rowToExportShape(r));
  const filtered = filterRows(shaped, toFilterOptions(opts));

  const absPath = resolve(process.cwd(), opts.output);
  mkdirSync(dirname(absPath), { recursive: true });

  if (opts.format === "csv") {
    writeFileSync(absPath, toCsv(filtered), "utf8");
  } else {
    writeFileSync(absPath, toJson(filtered), "utf8");
  }
  return filtered.length;
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  if (getBoolArg("--help", argv)) {
    process.stdout.write(HELP);
    return;
  }
  const opts = parseExportArgs(argv);
  const count = await runExport(opts);
  process.stdout.write(
    `wrote ${count} rows to ${opts.output} (format=${opts.format})\n`,
  );
}
