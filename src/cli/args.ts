// Minimal argv helpers. Accepts both "--flag value" and "--flag=value" forms
// so users don't have to remember which style is canonical. No dependency on
// a CLI framework — the surface is small enough that yargs/commander is
// overkill.
//
// Each helper accepts an explicit argv array so subcommand handlers can parse
// test fixtures without mutating process.argv. Defaulting to
// process.argv.slice(2) keeps the production call-site unchanged.
function argvOrDefault(argv?: string[]): string[] {
  return argv ?? process.argv.slice(2);
}

export function getArg(name: string, argv?: string[]): string | null {
  const a = argvOrDefault(argv);
  for (let i = 0; i < a.length; i++) {
    const cur = a[i] ?? "";
    if (cur === name) {
      const next = a[i + 1];
      if (next === undefined || next.startsWith("--")) return "";
      return next;
    }
    if (cur.startsWith(`${name}=`)) {
      return cur.slice(name.length + 1);
    }
  }
  return null;
}

// Presence-based. `--force` alone → true; `--force=false` → false.
export function getBoolArg(name: string, argv?: string[]): boolean {
  const v = getArg(name, argv);
  if (v === null) return false;
  if (v === "" || v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return true;
}

export function getNumberArg(name: string, argv?: string[]): number | null {
  const v = getArg(name, argv);
  if (v === null || v === "") return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

// Collects every occurrence of `--name value` / `--name=value`. Used for
// flags that can repeat (e.g. `--tier A --tier B1`). Returns [] when absent.
export function getRepeatableArg(name: string, argv?: string[]): string[] {
  const a = argvOrDefault(argv);
  const out: string[] = [];
  for (let i = 0; i < a.length; i++) {
    const cur = a[i] ?? "";
    if (cur === name) {
      const next = a[i + 1];
      if (next !== undefined && !next.startsWith("--")) out.push(next);
    } else if (cur.startsWith(`${name}=`)) {
      out.push(cur.slice(name.length + 1));
    }
  }
  return out;
}
