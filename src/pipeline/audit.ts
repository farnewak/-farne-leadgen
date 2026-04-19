import type { PlaceCandidate } from "../models/types.js";
import type { Tier, IntentTier, DiscoveryMethod } from "../models/audit.js";
import { detectParking } from "../tools/probe/parking-detect.js";
import { discoverLeads } from "./discover.js";
import { discoverViaDns } from "./dns-probe.js";
import { discoverViaCse } from "./cse-discovery.js";
import { classifyTier } from "./tier-classifier.js";
import { checkTransport } from "./ssl-check.js";
import { checkViewport } from "./viewport-check.js";
import { detectTechStack } from "./tech-stack.js";
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
  // Optional hook for tests: replaces the default discoverLeads() call.
  // Production callers pass undefined.
  discover?: (limit: number) => Promise<PlaceCandidate[]>;
}

// Top-level entry: discover candidates, fan out via the host limiter,
// swallow per-candidate failures. One bad lead never aborts the run.
export async function runAudit(options: AuditRunOptions = {}): Promise<void> {
  const limit = options.limit ?? 100;
  const candidates = options.discover
    ? await options.discover(limit)
    : await discoverLeads({ plz: null, maxLeads: limit });
  log.info(`audit starting on ${candidates.length} candidates (limit=${limit})`);

  let done = 0;
  const tasks = candidates.map((c) =>
    schedule(hostOf(c), async () => {
      await processOne(c, options).catch((err) => {
        log.error(`audit failed for ${c.placeId}`, (err as Error).message);
      });
      done += 1;
      if (done % 50 === 0) log.info(`progress: ${done}/${candidates.length}`);
    }),
  );
  await Promise.all(tasks);
  log.info(`audit done: ${done}/${candidates.length}`);
}

function hostOf(c: PlaceCandidate): string {
  if (!c.website) return "__discovery__";
  try {
    return new URL(c.website).host;
  } catch {
    return "__discovery__";
  }
}

async function processOne(
  candidate: PlaceCandidate,
  options: AuditRunOptions,
): Promise<void> {
  if (!options.forceRefresh) {
    const cached = await checkAuditCache(candidate.placeId);
    if (cached.staticFresh && cached.psiFresh) {
      log.debug(`skip ${candidate.placeId} (cache hit)`);
      return;
    }
  }
  try {
    const row = await auditOne(candidate);
    if (options.onlyTier && row.tier !== options.onlyTier) return;
    await upsertAudit(row);
  } catch (err) {
    log.warn(`auditOne threw for ${candidate.placeId}`, (err as Error).message);
    await markAuditError(candidate.placeId, "UNKNOWN", null);
  }
}

async function auditOne(candidate: PlaceCandidate): Promise<UpsertAuditInput> {
  const now = new Date();
  const discovery = await runDiscovery(candidate);
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
  return buildTierARow(candidate, discovery, now, intentTier);
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
  if (dns?.validated) {
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
  return {
    ssl,
    viewport: checkViewport(body),
    tech: detectTechStack(body, headers).signals,
    social: extractSocialLinks(body),
    schema: detectSchemaOrg(body),
    impressum,
  };
}
