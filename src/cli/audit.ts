import { runAudit } from "../pipeline/audit.js";
import { TIERS, type Tier } from "../models/audit.js";
import { resolveBezirk } from "../tools/geo/bezirk.js";
import { getArg, getBoolArg, getNumberArg } from "./args.js";

export async function main(): Promise<void> {
  const limit = getNumberArg("--limit");
  const force = getBoolArg("--force");
  const tierRaw = getArg("--tier");
  const bezirkRaw = getArg("--bezirk");

  let onlyTier: Tier | null = null;
  if (tierRaw !== null && tierRaw !== "") {
    if (!TIERS.includes(tierRaw as Tier)) {
      console.error(
        `Invalid --tier: ${tierRaw}. Allowed: ${TIERS.join(",")}`,
      );
      process.exit(1);
    }
    onlyTier = tierRaw as Tier;
  }

  // --bezirk accepts PLZ ("1030"), number ("3"), or name ("Landstraße").
  // Invalid input exits 1 with a clear error (spec §C I6).
  let plz: string | null = null;
  if (bezirkRaw !== null && bezirkRaw !== "") {
    const b = resolveBezirk(bezirkRaw);
    if (!b) {
      console.error(
        `Invalid --bezirk: ${bezirkRaw}. Expected PLZ 1010-1230, number 1-23, or Vienna district name.`,
      );
      process.exit(1);
    }
    plz = b.plz;
    console.log(
      `[audit] bezirk scope: ${b.number.toString().padStart(2, "0")} ${b.name} (PLZ ${b.plz})`,
    );
  }

  // `exactOptionalPropertyTypes` disallows `limit: undefined` when the
  // option itself is optional — build the object with the key omitted if
  // no --limit was given, rather than setting it to undefined explicitly.
  const opts: Parameters<typeof runAudit>[0] = {
    forceRefresh: force,
    onlyTier,
    plz,
  };
  if (limit !== null) opts.limit = limit;
  await runAudit(opts);
}
