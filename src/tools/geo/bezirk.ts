import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripUmlauts } from "../../lib/normalize.js";

// Vienna has 23 districts. Users can target a district by PLZ ("1010"),
// number ("1"–"23"), or name ("Innere Stadt", "Leopoldstadt", …). All
// three forms normalise to the canonical PLZ for downstream filtering
// (spec §C I1).

export interface BezirkRecord {
  number: number;
  name: string;
  plz: string;
  center: { lat: number; lng: number };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_PATH = resolve(HERE, "../../../data/wien-bezirke.json");

let cache: readonly BezirkRecord[] | null = null;

function load(): readonly BezirkRecord[] {
  if (!cache) {
    const raw = readFileSync(DATA_PATH, "utf-8");
    cache = JSON.parse(raw) as BezirkRecord[];
  }
  return cache;
}

export function allBezirke(): readonly BezirkRecord[] {
  return load();
}

// Case/umlaut-insensitive match used for name resolution. Two names that
// differ only in "ä" vs "ae" or casing must resolve to the same record.
function canonical(s: string): string {
  return stripUmlauts(s).toLowerCase().trim().replace(/\s+/g, " ");
}

export function resolveBezirk(input: string): BezirkRecord | null {
  const raw = input.trim();
  if (raw.length === 0) return null;
  const records = load();

  // PLZ form: "1010"–"1230" in steps of 10.
  if (/^\d{4}$/.test(raw)) {
    return records.find((r) => r.plz === raw) ?? null;
  }

  // Number form: "1"–"23".
  if (/^\d{1,2}$/.test(raw)) {
    const n = Number.parseInt(raw, 10);
    return records.find((r) => r.number === n) ?? null;
  }

  // Name form: case- and umlaut-insensitive.
  const key = canonical(raw);
  return records.find((r) => canonical(r.name) === key) ?? null;
}
