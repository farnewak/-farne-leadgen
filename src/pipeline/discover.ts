import type { PlaceCandidate, Industry } from "../models/types.js";
import { getActiveSources } from "../tools/datasources/registry.js";
import type {
  DataSource,
  DataSourceSearchOptions,
} from "../tools/datasources/types.js";
import { classifyIndustry } from "./classify.js";
import { filterChains } from "../tools/filters/chain-filter.js";
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

export interface SeedSearchResult {
  sourceId: string;
  places: PlaceCandidate[];
}

// Per-seed fallback: try each source in registry-priority order. A thrown
// exception (Overpass-504, ENOTFOUND, quota) is NOT fatal — we warn and
// move on to the next source. An empty-but-successful response ([]) is
// treated as success (no fallback), because "no matches" is valid data,
// unlike "the upstream died".
//
// Seed-shape note: both osm-overpass and google-places accept the same
// DataSourceSearchOptions shape (query, maxResults, plzFilter). Overpass
// ignores the query string internally — its first call returns the full
// Vienna dump and subsequent calls return [] thanks to its session-local
// `hasDelivered` guard — so we pass the options through verbatim, no
// translation required. If a future source diverges, adapt it here, not
// inside the source implementation.
export async function searchSeedWithFallback(
  options: DataSourceSearchOptions,
  sources: readonly DataSource[],
  seedLabel: string,
): Promise<SeedSearchResult> {
  if (sources.length === 0) {
    throw new Error(
      `discovery failed for seed "${seedLabel}" after 0 source(s)`,
    );
  }
  let lastError: unknown = undefined;
  for (let i = 0; i < sources.length; i++) {
    const source = sources[i]!;
    try {
      const places = await source.search(options);
      return { sourceId: source.id, places };
    } catch (err) {
      lastError = err;
      const fallbackSource = sources[i + 1]?.id ?? null;
      const errMsg = err instanceof Error ? err.message : String(err);
      log.warn(
        `source ${source.id} failed for seed "${seedLabel}": ${errMsg}`,
        {
          seed: seedLabel,
          failedSource: source.id,
          failedSourceError: errMsg,
          fallbackSource,
        },
      );
      if (fallbackSource) {
        log.info(
          `falling back to ${fallbackSource} for seed "${seedLabel}"`,
        );
      }
    }
  }
  throw new Error(
    `discovery failed for seed "${seedLabel}" after ${sources.length} source(s)`,
    { cause: lastError },
  );
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

    const { sourceId, places } = await searchSeedWithFallback(
      {
        query: `${seed.q}${plzSuffix}`,
        maxResults: perSeedBudget,
        plzFilter: input.plz,
      },
      sources,
      seed.q,
    );

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
        sourceId,
        (perSourceContribution.get(sourceId) ?? 0) + added,
      );
      log.debug(`source ${sourceId}: +${added} new leads for "${seed.q}"`);
    }
  }

  // Chain filter runs after dedup, before tier classification. It drops
  // only B2C mass-market franchise branches (Billa, Spar, McDonald's,
  // OMV …) and keeps premium single-owner businesses via whitelist
  // precedence. See src/tools/filters/chain-filter.ts for the contract.
  const deduped = Array.from(seen.values());
  const filtered = filterChains(deduped);
  const out = filtered.slice(0, input.maxLeads);
  const breakdown = Array.from(perSourceContribution.entries())
    .map(([id, n]) => `${id}=${n}`)
    .join(", ");
  log.info(
    `discovered ${out.length} leads${input.plz ? ` in ${input.plz}` : ""}` +
      (breakdown ? ` [${breakdown}]` : ""),
  );
  return out;
}
