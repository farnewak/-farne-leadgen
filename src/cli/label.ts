import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  LABEL_CHANNELS,
  LABEL_STATUSES,
  insertOutcome,
  isValidChannel,
  isValidStatus,
  type LabelChannel,
  type LabelStatus,
} from "../db/lead-outcomes.js";
import { getArg, getBoolArg } from "./args.js";

const HELP = `\
leadgen label — record a cold-outreach outcome against an audited lead.

Usage:
  leadgen label <lead-id> <status> [--channel <C>] [--note "..."]
  leadgen label --csv <path>

Arguments:
  <lead-id>              Matches audit_results.place_id (e.g. "osm:node:42").
  <status>               One of: ${LABEL_STATUSES.join(", ")}.

Options:
  --channel <C>          One of: ${LABEL_CHANNELS.join(", ")}. Optional.
  --note "..."           Free-form note. Optional.
  --csv <path>           Bulk import. CSV header: lead_id,status,channel,notes.
  --help                 Show this help and exit 0.

Outcomes are append-only — each call writes a new row (spec §C I2). P0 only
collects labels; no scoring retrain happens here (§C I6).
`;

// Thin positional parser: walks argv, skips every "--flag value" pair and
// collects the remaining tokens. We restrict this to the known value-taking
// flags so boolean flags like --help are handled correctly.
const VALUE_FLAGS = new Set(["--channel", "--note", "--csv"]);

function splitPositionals(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const cur = argv[i] ?? "";
    if (cur.startsWith("--")) {
      const [name] = cur.split("=");
      if (!cur.includes("=") && VALUE_FLAGS.has(name ?? "")) i += 1;
      continue;
    }
    out.push(cur);
  }
  return out;
}

export interface SingleLabelInput {
  leadId: string;
  status: LabelStatus;
  channel: LabelChannel | null;
  note: string | null;
}

export function parseSingle(argv: string[]): SingleLabelInput {
  const positionals = splitPositionals(argv);
  if (positionals.length < 2) {
    throw new Error(
      `label: missing arguments. Expected: <lead-id> <status>. Got ${positionals.length}.`,
    );
  }
  const [leadId, statusRaw] = positionals;
  if (!leadId || leadId.length === 0) {
    throw new Error("label: <lead-id> is required");
  }
  if (!statusRaw || !isValidStatus(statusRaw)) {
    throw new Error(
      `label: invalid status "${statusRaw ?? ""}". Allowed: ${LABEL_STATUSES.join(", ")}`,
    );
  }

  const channelRaw = getArg("--channel", argv);
  let channel: LabelChannel | null = null;
  if (channelRaw !== null && channelRaw !== "") {
    if (!isValidChannel(channelRaw)) {
      throw new Error(
        `label: invalid --channel "${channelRaw}". Allowed: ${LABEL_CHANNELS.join(", ")}`,
      );
    }
    channel = channelRaw;
  }

  const noteRaw = getArg("--note", argv);
  const note = noteRaw !== null && noteRaw !== "" ? noteRaw : null;

  return { leadId, status: statusRaw, channel, note };
}

// Minimal CSV parser for the header {lead_id,status,channel,notes}. Supports
// double-quoted fields with embedded commas and "" escapes; rejects everything
// else. We deliberately do not pull in a CSV lib for 40 lines of code.
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export interface CsvRow {
  leadId: string;
  status: LabelStatus;
  channel: LabelChannel | null;
  notes: string | null;
}

export function parseCsv(text: string): CsvRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0] ?? "").map((s) => s.trim().toLowerCase());
  const expected = ["lead_id", "status", "channel", "notes"];
  for (const col of expected) {
    if (!header.includes(col)) {
      throw new Error(
        `label --csv: header missing column "${col}". Got: ${header.join(",")}`,
      );
    }
  }
  const idx = (c: string): number => header.indexOf(c);
  const out: CsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i] ?? "");
    const leadId = (cells[idx("lead_id")] ?? "").trim();
    const statusRaw = (cells[idx("status")] ?? "").trim();
    const channelRaw = (cells[idx("channel")] ?? "").trim();
    const notesRaw = cells[idx("notes")] ?? "";
    if (!leadId) throw new Error(`label --csv: row ${i + 1} missing lead_id`);
    if (!isValidStatus(statusRaw)) {
      throw new Error(
        `label --csv: row ${i + 1} invalid status "${statusRaw}". Allowed: ${LABEL_STATUSES.join(", ")}`,
      );
    }
    let channel: LabelChannel | null = null;
    if (channelRaw.length > 0) {
      if (!isValidChannel(channelRaw)) {
        throw new Error(
          `label --csv: row ${i + 1} invalid channel "${channelRaw}". Allowed: ${LABEL_CHANNELS.join(", ")}`,
        );
      }
      channel = channelRaw;
    }
    out.push({
      leadId,
      status: statusRaw,
      channel,
      notes: notesRaw.length > 0 ? notesRaw : null,
    });
  }
  return out;
}

export async function runLabelSingle(input: SingleLabelInput): Promise<void> {
  await insertOutcome({
    leadId: input.leadId,
    status: input.status,
    channel: input.channel,
    notes: input.note,
  });
}

export async function runLabelCsv(path: string): Promise<number> {
  const abs = resolve(process.cwd(), path);
  const text = readFileSync(abs, "utf8");
  const rows = parseCsv(text);
  for (const r of rows) {
    await insertOutcome({
      leadId: r.leadId,
      status: r.status,
      channel: r.channel,
      notes: r.notes,
    });
  }
  return rows.length;
}

export async function main(
  argv: string[] = process.argv.slice(2),
): Promise<void> {
  // The dispatcher in src/cli/index.ts forwards "label" as argv[0]; strip it
  // so our positional parser lines up.
  const args = argv[0] === "label" ? argv.slice(1) : argv;

  if (getBoolArg("--help", args)) {
    process.stdout.write(HELP);
    return;
  }

  const csvPath = getArg("--csv", args);
  if (csvPath !== null && csvPath !== "") {
    const n = await runLabelCsv(csvPath);
    process.stdout.write(`${n} labels collected\n`);
    return;
  }

  const input = parseSingle(args);
  await runLabelSingle(input);
  process.stdout.write(`1 labels collected\n`);
}
