import { discoverLeads } from "../pipeline/discover.js";
import { getArg, getNumberArg } from "./args.js";
import { makeLogger } from "../lib/logger.js";

const log = makeLogger("cli:discover");

// Thin wrapper around discoverLeads for the `leadgen discover` subcommand.
// Printing + DB persistence stay out of scope for now — the audit subcommand
// is the real production entry point. This command is mostly diagnostic.
export async function main(): Promise<void> {
  const plz = getArg("--plz");
  const max = getNumberArg("--max") ?? 100;

  const leads = await discoverLeads({
    plz: plz && plz.length > 0 ? plz : null,
    maxLeads: max,
  });
  log.info(`discovered ${leads.length} leads`);
  for (const l of leads) {
    console.log(`${l.placeId}\t${l.name}\t${l.website ?? ""}`);
  }
}
