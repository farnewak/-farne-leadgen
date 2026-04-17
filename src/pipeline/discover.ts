import type { PlaceCandidate, Industry } from "../models/types.js";
import { searchVienna } from "../tools/google-maps.js";
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

  for (const seed of SEED_QUERIES) {
    if (seen.size >= input.maxLeads) break;

    const remaining = input.maxLeads - seen.size;
    const perSeedBudget = Math.min(20, Math.ceil(remaining * 1.5));

    log.info(`seed "${seed.q}" → budget ${perSeedBudget}, seen ${seen.size}`);
    const places = await searchVienna({
      query: `${seed.q}${plzSuffix}`,
      maxResults: perSeedBudget,
      plzFilter: input.plz,
    });

    for (const p of places) {
      if (seen.has(p.placeId)) continue;
      const industry = classifyIndustry(p.types, p.primaryType);
      seen.set(p.placeId, { ...p, industry });
      if (seen.size >= input.maxLeads) break;
    }
  }

  const out = Array.from(seen.values()).slice(0, input.maxLeads);
  log.info(`discovered ${out.length} leads${input.plz ? ` in ${input.plz}` : ""}`);
  return out;
}
