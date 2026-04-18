import type { PlaceCandidate, Industry } from "../models/types.js";
import { getActiveSources } from "../tools/datasources/registry.js";
import { classifyIndustry } from "./classify.js";
import { makeLogger } from "../lib/logger.js";

const log = makeLogger("discover");

// Seed queries across the 7 industry buckets. Horizontal scan per plan §1.
// Each seed hits up to 20 places; Google returns different sets for
// German vs. English terms, so we mix both sparingly.
const SEED_QUERIES: Array<{ q: string; hintIndustry: Industry }> = [
  { q: "Restaurant", hintIndustry: "gastronomy" },
  { q: "Café", hintIndustry: "gastronomy" },
  { q: "Bar", hintIndustry: "gastronomy" },
  { q: "Bäckerei", hintIndustry: "gastronomy" },
  { q: "Geschäft", hintIndustry: "retail" },
  { q: "Mode", hintIndustry: "retail" },
  { q: "Juwelier", hintIndustry: "retail" },
  { q: "Friseur", hintIndustry: "beauty" },
  { q: "Kosmetik", hintIndustry: "beauty" },
  { q: "Arzt", hintIndustry: "health" },
  { q: "Zahnarzt", hintIndustry: "health" },
  { q: "Rechtsanwalt", hintIndustry: "services" },
  { q: "Steuerberater", hintIndustry: "services" },
  { q: "Installateur", hintIndustry: "crafts" },
  { q: "Elektriker", hintIndustry: "crafts" },
  { q: "Tischler", hintIndustry: "crafts" },
];

export interface DiscoverInput {
  plz: string | null;
  maxLeads: number;
}

export interface DiscoveredLead extends PlaceCandidate {
  industry: Industry;
}

export async function discoverLeads(
  input: DiscoverInput,
): Promise<DiscoveredLead[]> {
  const seen = new Map<string, DiscoveredLead>();
  const plzSuffix = input.plz ? ` ${input.plz} Wien` : " Wien";

  const sources = getActiveSources();
  const perSourceContribution = new Map<string, number>();

  for (const seed of SEED_QUERIES) {
    if (seen.size >= input.maxLeads) break;

    const remaining = input.maxLeads - seen.size;
    const perSeedBudget = Math.min(20, Math.ceil(remaining * 1.5));

    log.info(`seed "${seed.q}" → budget ${perSeedBudget}, seen ${seen.size}`);

    for (const source of sources) {
      if (seen.size >= input.maxLeads) break;

      const places = await source.search({
        query: `${seed.q}${plzSuffix}`,
        maxResults: perSeedBudget,
        plzFilter: input.plz,
      });

      let added = 0;
      for (const p of places) {
        if (seen.has(p.placeId)) continue;
        const industry = classifyIndustry(p.types, p.primaryType);
        seen.set(p.placeId, { ...p, industry });
        added += 1;
        if (seen.size >= input.maxLeads) break;
      }
      if (added > 0) {
        perSourceContribution.set(
          source.id,
          (perSourceContribution.get(source.id) ?? 0) + added,
        );
        log.debug(`source ${source.id}: +${added} new leads for "${seed.q}"`);
      }
    }
  }

  const out = Array.from(seen.values()).slice(0, input.maxLeads);
  const breakdown = Array.from(perSourceContribution.entries())
    .map(([id, n]) => `${id}=${n}`)
    .join(", ");
  log.info(
    `discovered ${out.length} leads${input.plz ? ` in ${input.plz}` : ""}` +
      (breakdown ? ` [${breakdown}]` : ""),
  );
  return out;
}
