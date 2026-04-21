import type { PlaceCandidate } from "../models/types.js";
import type {
  Tier,
  IntentTier,
  DiscoveryMethod,
  ImpressumData,
} from "../models/audit.js";
import { detectParking } from "../tools/probe/parking-detect.js";
import {
  enrichB3Candidate,
  enrichImpressumContacts,
  mergeEnrichment,
} from "./enrich.js";
import type { ScrapedContact } from "../tools/enrich/impressum-scraper.js";
import { discoverLeads } from "./discover.js";
import {
  loadChainBranchPatterns,
  matchesChainBranch,
  appendFilteredChainBranchLog,
  type ChainBranchPattern,
} from "./chain-filter.js";
import { dedupeChainApices } from "./chain-apex-dedupe.js";
import { resolve } from "node:path";
import { discoverViaDns } from "./dns-probe.js";
import { discoverViaCse } from "./cse-discovery.js";
import { classifyTier } from "./tier-classifier.js";
import { checkTransport } from "./ssl-check.js";
import { checkViewport } from "./viewport-check.js";
import { detectTechStack } from "./tech-stack.js";
import { detectCms } from "./cms-detect.js";
import { extractSocialLinks } from "./social-links.js";
import { detectSchemaOrg } from "./schema-org.js";
import { fetchAndParseImpressum } from "./impressum.js";
import { runPsiMobile } from "./psi.js";
import { getRobotsRules } from "./robots.js";
import { computeScore } from "./score.js";
import { fetchUrl } from "../lib/http-fetch.js";
import { schedule } from "../lib/host-limiter.js";
import {
  checkAuditCache,
  upsertAudit,
  markAuditError,
  type UpsertAuditInput,
} from "../db/audit-cache.js";
import { loadEnv } from "../lib/env.js";
import { makeLogger } from "../lib/logger.js";
import {
  buildEmptyTierRow,
  assembleAuditRow,
  buildRobotsDisallowedRow,
  type DiscoveryOutcome,
  type GatheredSignals,
} from "./audit-row-builders.js";

const log = makeLogger("audit");

export interface AuditRunOptions {
  limit?: number;
  forceRefresh?: boolean;
  onlyTier?: Tier | null;
  // When set, discovery is scoped to this Vienna PLZ (e.g. "1030"). Null
  // keeps the historical Wien-wide behaviour.
  plz?: string | null;
  // Optional hook for tests: replaces the default discoverLeads() call.
  // Production callers pass undefined.
  discover?: (limit: number) => Promise<PlaceCandidate[]>;
  // Optional hook for tests: replaces the Places Text-Search lookup used
  // by B3-enrichment. When set, the enricher skips its API-key / feature-
  // flag gating and still writes to the cache dir (spec §D cache-hit test).
  findPlaceByQuery?: (
    query: string,
  ) => Promise<
    import("../tools/datasources/google-places.js").PlacesQueryMatch | null
  >;
  enrichCacheDir?: string;
  // Test hooks for the aggressive Impressum scraper. `impressumFetch` lets
  // tests inject a stub HTTP client; `impressumCacheDir` points the scraper
  // at a throwaway temp dir so runs don't leak into production caches.
  impressumFetch?: typeof import("../lib/http-fetch.js").fetchUrl;
  impressumCacheDir?: string;
  // FIX 5: chain-branch filter hooks. `chainBranchesConfig` points at a
  // custom YAML file (default: ./config/chain_branches.yml). `logDir` is
  // the directory where logs/filtered_chain_branches.csv lands — tests
  // redirect it to a tmp dir so real `logs/` is never touched.
  chainBranchesConfig?: string;
  logDir?: string;
  // FIX 6 test hook: injectable apex auditor. Production callers leave
  // this undefined — the default path runs a real `auditOne` against a
  // synthetic apex candidate. Tests pass a mock that returns a scored
  // UpsertAuditInput without touching the network.
  auditApex?: (apex: string) => Promise<UpsertAuditInput | null>;
}

// Default locations. `logs/` is created lazily on first filter-hit.
const DEFAULT_CHAIN_BRANCHES_CONFIG = resolve(
  process.cwd(),
  "config/chain_branches.yml",
);
const DEFAULT_LOG_DIR = resolve(process.cwd(), "logs");

// Top-level entry: discover candidates, fan out via the host limiter,
// swallow per-candidate failures. One bad lead never aborts the run.
export async function runAudit(options: AuditRunOptions = {}): Promise<void> {
  const limit = options.limit ?? 100;
  const plz = options.plz ?? null;
  const candidates = options.discover
    ? await options.discover(limit)
    : await discoverLeads({ plz, maxLeads: limit });
  log.info(
    `audit starting on ${candidates.length} candidates (limit=${limit}` +
      (plz ? `, plz=${plz}` : "") +
      `)`,
  );

  // Load chain-branch patterns once per run. Parse errors surface here
  // rather than at per-row match time, so a malformed YAML fails the run
  // early instead of silently dropping the filter.
  const chainPatterns = loadChainPatternsSafe(options);

  // Collect per-row audit results (null = dropped by auditOne or chain-
  // branch filter). The batch-stage apex dedupe runs AFTER all per-row
  // work completes so it can see the full group of Tier-A rows that
  // share an apex.
  const collected: UpsertAuditInput[] = [];
  let done = 0;
  const tasks = candidates.map((c) =>
    schedule(hostOf(c), async () => {
      try {
        const row = await processOne(c, options, chainPatterns);
        if (row !== null) collected.push(row);
      } catch (err) {
        log.error(`audit failed for ${c.placeId}`, (err as Error).message);
      }
      done += 1;
      if (done % 50 === 0) log.info(`progress: ${done}/${candidates.length}`);
    }),
  );
  await Promise.all(tasks);

  // FIX 6: chain-apex dedupe. Batch operation over all Tier-A survivors
  // that still have a discoveredUrl. Clean-apex groups drop their
  // branches; bad-apex groups collapse to a single canonical row.
  const logDir = options.logDir ?? DEFAULT_LOG_DIR;
  const apexAuditor =
    options.auditApex ?? ((apex: string) => defaultApexAudit(apex, options));
  const dedupe = await dedupeChainApices(collected, {
    auditApex: apexAuditor,
    logDir,
  });
  log.info(
    `apex dedupe: collapsed=${dedupe.collapsedGroups} branches dropped=${dedupe.droppedBranches} collapsed=${dedupe.collapsedBranches}`,
  );

  // Apply the --onlyTier flag at the final persist stage so dedupe sees
  // the full Tier-A population (an --onlyTier=B run still wants chain
  // filtering for the A rows it produces, not that it persists any).
  const finalRows = options.onlyTier
    ? dedupe.survivors.filter((r) => r.tier === options.onlyTier)
    : dedupe.survivors;

  for (const row of finalRows) {
    try {
      await upsertAudit(row);
    } catch (err) {
      log.warn(
        `upsert failed for ${row.placeId}: ${(err as Error).message}`,
      );
    }
  }

  log.info(`audit done: ${done}/${candidates.length}`);
}

// Default apex auditor: builds a synthetic PlaceCandidate for the apex
// homepage and runs the full auditOne path against it. Reuses every
// signal collector so the decision (drop vs collapse) is grounded in
// the same scoring model we use for real rows.
async function defaultApexAudit(
  apex: string,
  options: AuditRunOptions,
): Promise<UpsertAuditInput | null> {
  const syntheticCandidate: PlaceCandidate = {
    placeId: `apex:${apex}`,
    name: apex,
    address: null,
    plz: null,
    district: null,
    types: [],
    primaryType: null,
    website: `https://${apex}/`,
    phone: null,
    lat: 0,
    lng: 0,
  };
  try {
    return await auditOne(syntheticCandidate, options);
  } catch (err) {
    log.warn(`apex audit failed for ${apex}: ${(err as Error).message}`);
    return null;
  }
}

function loadChainPatternsSafe(
  options: AuditRunOptions,
): ChainBranchPattern[] {
  const path = options.chainBranchesConfig ?? DEFAULT_CHAIN_BRANCHES_CONFIG;
  try {
    return loadChainBranchPatterns(path);
  } catch (err) {
    // Missing default config is tolerated (e.g. fresh checkout without the
    // YAML). A custom path that fails to load is an explicit user choice
    // and re-thrown.
    if (options.chainBranchesConfig) throw err;
    log.warn(
      `chain-branch filter disabled: ${(err as Error).message} (at ${path})`,
    );
    return [];
  }
}

function hostOf(c: PlaceCandidate): string {
  if (!c.website) return "__discovery__";
  try {
    return new URL(c.website).host;
  } catch {
    return "__discovery__";
  }
}

// processOne now returns the audit row instead of persisting it. The
// caller (runAudit) batches all rows, runs chain-apex dedupe, and then
// upserts the survivors. Returns null when the row was dropped (cache
// hit, auditOne returned null, or chain-branch filter matched).
async function processOne(
  candidate: PlaceCandidate,
  options: AuditRunOptions,
  chainPatterns: ChainBranchPattern[],
): Promise<UpsertAuditInput | null> {
  if (!options.forceRefresh) {
    const cached = await checkAuditCache(candidate.placeId);
    if (cached.staticFresh && cached.psiFresh) {
      log.debug(`skip ${candidate.placeId} (cache hit)`);
      return null;
    }
  }
  try {
    const row = await auditOne(candidate, options);
    if (row === null) {
      // Dropped by enrichment (CLOSED_PERMANENTLY) — no DB row written.
      return null;
    }
    // FIX 5: chain-branch filter. Runs AFTER parking detection (which
    // happens inside auditOne) and BEFORE chain-apex dedupe (FIX 6).
    // Matched rows are logged and removed from the stage1 stream; they
    // never reach the dedupe stage or audit_results.
    if (row.discoveredUrl && chainPatterns.length > 0) {
      const match = matchesChainBranch(row.discoveredUrl, chainPatterns);
      if (match) {
        const logDir = options.logDir ?? DEFAULT_LOG_DIR;
        const csvPath = resolve(logDir, "filtered_chain_branches.csv");
        appendFilteredChainBranchLog(
          {
            place_id: row.placeId,
            chain_name: match.chain_name,
            url: row.discoveredUrl,
            matched_pattern: match.matched_pattern,
            reason: match.reason,
            filtered_at: new Date(),
          },
          csvPath,
        );
        log.info(
          `chain-branch filter: drop ${row.placeId} (${match.chain_name}, ${match.matched_pattern})`,
        );
        return null;
      }
    }
    return row;
  } catch (err) {
    log.warn(`auditOne threw for ${candidate.placeId}`, (err as Error).message);
    await markAuditError(candidate.placeId, "UNKNOWN", null);
    return null;
  }
}

async function auditOne(
  candidateIn: PlaceCandidate,
  options: AuditRunOptions = {},
): Promise<UpsertAuditInput | null> {
  const now = new Date();
  let candidate = candidateIn;
  let discovery = await runDiscovery(candidate);

  // B3-enrichment: if discovery found no URL, ask Google Places whether the
  // business has one registered there. On CLOSED_PERMANENTLY, drop the lead
  // entirely (I7). On a websiteUri hit, merge + re-probe so the candidate
  // enters the normal tier-A path. Phone/address fill in missing candidate
  // fields only (I6 — OSM has priority).
  if (discovery.discoveredUrl === null) {
    const enrichOpts: Parameters<typeof enrichB3Candidate>[1] = {};
    if (options.findPlaceByQuery) {
      enrichOpts.findPlaceByQuery = options.findPlaceByQuery;
    }
    if (options.enrichCacheDir) enrichOpts.cacheDir = options.enrichCacheDir;
    const enriched = await enrichB3Candidate(candidate, enrichOpts);
    if (enriched.verdict === "drop") {
      log.info(`dropping ${candidate.placeId} (CLOSED_PERMANENTLY)`);
      return null;
    }
    if (enriched.verdict === "updated" && enriched.match) {
      candidate = mergeEnrichment(candidate, enriched.match);
      if (candidate.website) {
        discovery = await probeHome(candidate.website, "gplaces-tag", {
          discoveredUrl: null,
          discoveryMethod: null,
          fetchError: null,
          homeBody: null,
          homeHeaders: {},
          finalUrl: null,
        });
      }
    }
  }

  // Aggressive Impressum scrape for contact-coverage (P0). Runs AFTER
  // B3-enrichment so a Places-discovered website is also covered. Only
  // active when the candidate actually has a website (spec I1).
  const scraped = await scrapeContacts(candidate, options);
  if (scraped) {
    // Surface scraped phone/address on the candidate so the empty-tier
    // row-builder (which reads candidate.phone / candidate.address) sees
    // them. OSM values still take priority — merge is gap-fill only.
    candidate = {
      ...candidate,
      phone: candidate.phone ?? scraped.phone,
      address: candidate.address ?? scraped.address,
    };
  }

  let tier = classifyTier({
    hasDiscoveredUrl: discovery.discoveredUrl !== null,
    fetchError: discovery.fetchError,
    // v0.1: social/directory counts from CSE link-mining are pending
    // (open-work-item #14). Without a site we default to B3.
    socialLinksCount: 0,
    directoryHitsCount: 0,
  });

  // Parking-detection override: a 200-OK parking page looks like a
  // healthy Tier-A site to the tier-classifier because there's no fetch
  // error. We must inspect the body and reclassify to tier=C with
  // intent_tier=PARKED before building the row. Per spec I7, the check
  // only runs when we have a discovered URL (B3 candidates skip entirely).
  // Per I3, any ambiguity defaults to DEAD, never PARKED.
  let intentTier: IntentTier = classifyIntentTier(tier, discovery);
  if (tier === "A" && discovery.discoveredUrl && discovery.homeBody) {
    const parking = detectParking({
      body: discovery.homeBody,
      finalUrl: discovery.finalUrl,
      headers: discovery.homeHeaders,
    });
    if (parking.verdict === "parked") {
      log.info(
        `parking detected for ${candidate.placeId} (${parking.fingerprint})`,
      );
      tier = "C";
      intentTier = "PARKED";
    }
  }

  if (tier !== "A" || !discovery.discoveredUrl) {
    return buildEmptyTierRow(candidate, tier, discovery, now, intentTier);
  }
  return buildTierARow(candidate, discovery, now, intentTier, scraped);
}

// Thin shim that runs the aggressive Impressum scraper when a website is
// available, wiring the audit-run test hooks (injected fetcher + temp cache
// dir) into the scraper. Returns null when the flag is off or no website.
async function scrapeContacts(
  candidate: PlaceCandidate,
  options: AuditRunOptions,
): Promise<ScrapedContact | null> {
  if (!candidate.website) return null;
  const scrapeOpts: Parameters<typeof enrichImpressumContacts>[1] = {};
  if (options.impressumFetch) scrapeOpts.fetch = options.impressumFetch;
  if (options.impressumCacheDir) {
    scrapeOpts.cacheDir = options.impressumCacheDir;
  }
  try {
    const res = await enrichImpressumContacts(candidate, scrapeOpts);
    return res?.contact ?? null;
  } catch (err) {
    log.warn(
      `impressum scrape failed for ${candidate.placeId}: ${
        (err as Error).message
      }`,
    );
    return null;
  }
}

// Adapter: ScrapedContact → ImpressumData. Preserves priority semantics:
// if the legacy in-signals Impressum fetch already produced data, that
// data wins (it used a longer budget and two-stage DOM walk). Scraper
// results only fill gaps.
function mergeImpressum(
  legacy: ImpressumData,
  scraped: ScrapedContact | null,
): ImpressumData {
  if (!scraped) return legacy;
  const url = legacy.url ?? scraped.impressumUrl;
  const uid = legacy.uid ?? scraped.uid;
  const companyName = legacy.companyName ?? scraped.companyName;
  const address = legacy.address ?? scraped.address;
  const phone = legacy.phone ?? scraped.phone;
  const email = legacy.email ?? scraped.email;
  const present = legacy.present || url !== null;
  const complete = Boolean(uid && companyName && address);
  return {
    present,
    url,
    uid,
    companyName,
    address,
    phone,
    email,
    complete,
  };
}

// Derives intent-tier from the existing tier + discovery outcome. Used
// as the default before parking-detect has a chance to override.
function classifyIntentTier(
  tier: Tier,
  discovery: DiscoveryOutcome,
): IntentTier {
  if (tier === "A" && discovery.discoveredUrl && !discovery.fetchError) {
    return "LIVE";
  }
  if (tier === "C") return "DEAD";
  // FIX 4: tier B3 means we never found a URL for this lead. The domain-
  // level signal is "no website at all", not the legacy NONE catch-all.
  // Tier B1/B2 (social/directory-only) stay NONE because they do have
  // *some* web surface, just not a primary site.
  if (tier === "B3") return "DEAD_WEBSITE";
  return "NONE";
}

async function runDiscovery(candidate: PlaceCandidate): Promise<DiscoveryOutcome> {
  const base: DiscoveryOutcome = {
    discoveredUrl: null,
    discoveryMethod: null,
    fetchError: null,
    homeBody: null,
    homeHeaders: {},
    finalUrl: null,
  };
  if (candidate.website) {
    return await probeHome(candidate.website, "osm-tag", base);
  }
  const dns = await discoverViaDns(candidate);
  if (dns.found && dns.validated) {
    return await probeHome(dns.candidateUrl, "dns-probe", base);
  }
  const cse = await discoverViaCse(candidate);
  if (cse) {
    return await probeHome(cse.discoveredUrl, "cse", base);
  }
  return base;
}

// Single GET of the discovered URL so downstream extractors reuse the body.
// fetchError is carried into the DiscoveryOutcome so tier-classifier can see it.
async function probeHome(
  url: string,
  method: DiscoveryMethod,
  base: DiscoveryOutcome,
): Promise<DiscoveryOutcome> {
  const res = await fetchUrl(url);
  return {
    ...base,
    discoveredUrl: url,
    discoveryMethod: method,
    fetchError: res.error,
    homeBody: res.error ? null : res.body,
    homeHeaders: res.error ? {} : res.headers,
    finalUrl: res.error ? null : res.finalUrl,
  };
}

async function buildTierARow(
  candidate: PlaceCandidate,
  discovery: DiscoveryOutcome,
  now: Date,
  intentTier: IntentTier,
  scraped: ScrapedContact | null,
): Promise<UpsertAuditInput> {
  const env = loadEnv();
  const url = discovery.discoveredUrl!;
  const host = new URL(url).host;

  if (env.AUDIT_RESPECT_ROBOTS_TXT) {
    const robots = await getRobotsRules(`https://${host}`);
    if (!robots.allowed(new URL(url).pathname)) {
      return buildRobotsDisallowedRow(candidate, discovery, now);
    }
  }

  const signals = await gatherSignals(url, host, discovery);
  // Merge aggressive-scraper results into the canonical ImpressumData,
  // preferring the legacy in-signals fetch when it already found a value.
  signals.impressum = mergeImpressum(signals.impressum, scraped);
  const psi = await runPsiMobile(url);

  const score = computeScore({
    tier: "A",
    sslValid: signals.ssl.sslValid,
    httpToHttpsRedirect: signals.ssl.httpToHttpsRedirect,
    hasViewportMeta: signals.viewport.hasViewportMeta,
    psiMobilePerformance: psi.performance,
    impressumPresent: signals.impressum.present,
    impressumComplete: signals.impressum.complete,
    impressumUid: signals.impressum.uid,
    techStack: signals.tech,
    socialLinks: signals.social,
    hasStructuredData: signals.schema.hasSchemaOrg,
    intentTier,
  });
  return assembleAuditRow(
    candidate,
    discovery,
    now,
    signals,
    psi,
    score,
    intentTier,
  );
}

// Parallel-fan signal extraction. Home body already fetched in runDiscovery
// so viewport/tech/social/schema run synchronously on that cached body.
// SSL and Impressum do their own network I/O.
async function gatherSignals(
  url: string,
  host: string,
  discovery: DiscoveryOutcome,
): Promise<GatheredSignals> {
  const body = discovery.homeBody ?? "";
  const headers = discovery.homeHeaders;
  const [ssl, impressum] = await Promise.all([
    checkTransport(host),
    fetchAndParseImpressum(url),
  ]);
  const tech = detectTechStack(body, headers).signals;
  // FIX 10 — cascaded CMS detector. Produces a single canonical slug that
  // replaces the tech-stack fingerprint's cms array for this row. Steps B/C/D
  // use weaker evidence than the MIN_MATCHES=2 fingerprint, so running them
  // AFTER detectTechStack ensures the high-confidence fingerprint still wins.
  // On Tier-A rows with a robots-disallowed skip or an empty body, the
  // detector collapses to "unknown".
  const cmsResult = detectCms({ body, headers, existingCms: tech.cms });
  tech.cms = [cmsResult.cms];
  return {
    ssl,
    viewport: checkViewport(body),
    tech,
    social: extractSocialLinks(body),
    schema: detectSchemaOrg(body),
    impressum,
  };
}
