// Minimal argv helpers. Accepts both "--flag value" and "--flag=value" forms
// so users don't have to remember which style is canonical. No dependency on
// a CLI framework — the surface is small enough that yargs/commander is
// overkill.
const argv: string[] = process.argv.slice(2);

export function getArg(name: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a === name) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) return "";
      return next;
    }
    if (a.startsWith(`${name}=`)) {
      return a.slice(name.length + 1);
    }
  }
  return null;
}

// Presence-based. `--force` alone → true; `--force=false` → false.
export function getBoolArg(name: string): boolean {
  const v = getArg(name);
  if (v === null) return false;
  if (v === "" || v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return true;
}

export function getNumberArg(name: string): number | null {
  const v = getArg(name);
  if (v === null || v === "") return null;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
