import { runAudit } from "../pipeline/audit.js";
import { TIERS, type Tier } from "../models/audit.js";
import { getArg, getBoolArg, getNumberArg } from "./args.js";

export async function main(): Promise<void> {
  const limit = getNumberArg("--limit");
  const force = getBoolArg("--force");
  const tierRaw = getArg("--tier");

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

  // `exactOptionalPropertyTypes` disallows `limit: undefined` when the
  // option itself is optional — build the object with the key omitted if
  // no --limit was given, rather than setting it to undefined explicitly.
  const opts: Parameters<typeof runAudit>[0] = { forceRefresh: force, onlyTier };
  if (limit !== null) opts.limit = limit;
  await runAudit(opts);
}
