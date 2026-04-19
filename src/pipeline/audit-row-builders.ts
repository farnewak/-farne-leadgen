import type { PlaceCandidate } from "../models/types.js";
import type {
  Tier,
  IntentTier,
  DiscoveryMethod,
  FetchError,
  TechStackSignals,
  SocialLinks,
  ImpressumData,
} from "../models/audit.js";
import type { UpsertAuditInput } from "../db/audit-cache.js";
import type { checkTransport } from "./ssl-check.js";
import type { checkViewport } from "./viewport-check.js";
import type { detectSchemaOrg } from "./schema-org.js";
import type { runPsiMobile } from "./psi.js";
import { computeScore } from "./score.js";
import { loadEnv } from "../lib/env.js";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface DiscoveryOutcome {
  discoveredUrl: string | null;
  discoveryMethod: DiscoveryMethod | null;
  fetchError: FetchError | null;
  homeBody: string | null;
  homeHeaders: Record<string, string>;
  finalUrl: string | null;
}

export interface GatheredSignals {
  ssl: Awaited<ReturnType<typeof checkTransport>>;
  viewport: ReturnType<typeof checkViewport>;
  tech: TechStackSignals;
  social: SocialLinks;
  schema: ReturnType<typeof detectSchemaOrg>;
  impressum: ImpressumData;
}

export function emptyTechStack(): TechStackSignals {
  return {
    cms: [],
    pageBuilder: [],
    analytics: [],
    tracking: [],
    payment: [],
    cdn: [],
  };
}

// Row factory for tiers B1/B2/B3/C (or A-without-discoveredUrl edge). Uses
// computeScore's tier-only branch; no signal columns populated.
// `candidate.phone` / `candidate.address` are surfaced via impressumPhone /
// impressumAddress so enriched B3 contacts end up in the CSV export.
// For non-enriched rows these fields are null, matching prior behaviour.
export function buildEmptyTierRow(
  candidate: PlaceCandidate,
  tier: Tier,
  discovery: DiscoveryOutcome,
  now: Date,
  intentTier: IntentTier | null = null,
): UpsertAuditInput {
  const env = loadEnv();
  const score = computeScore({
    tier,
    sslValid: null,
    httpToHttpsRedirect: null,
    hasViewportMeta: null,
    psiMobilePerformance: null,
    impressumPresent: false,
    impressumComplete: null,
    impressumUid: null,
    techStack: emptyTechStack(),
    socialLinks: {},
    hasStructuredData: false,
    intentTier,
  });
  return {
    placeId: candidate.placeId,
    auditedAt: now,
    tier,
    discoveredUrl: discovery.discoveredUrl,
    discoveryMethod: discovery.discoveryMethod,
    sslValid: null,
    sslExpiresAt: null,
    httpToHttpsRedirect: null,
    hasViewportMeta: null,
    viewportMetaContent: null,
    psiMobilePerformance: null,
    psiMobileSeo: null,
    psiMobileAccessibility: null,
    psiMobileBestPractices: null,
    psiFetchedAt: null,
    impressumUrl: null,
    impressumPresent: false,
    impressumUid: null,
    impressumCompanyName: null,
    impressumAddress: candidate.address,
    impressumPhone: candidate.phone,
    impressumEmail: null,
    impressumComplete: null,
    techStack: emptyTechStack(),
    genericEmails: [],
    socialLinks: {},
    fetchError: discovery.fetchError,
    fetchErrorAt: discovery.fetchError ? now : null,
    intentTier,
    staticSignalsExpiresAt: new Date(
      now.getTime() + env.AUDIT_STATIC_TTL_DAYS * DAY_MS,
    ),
    psiSignalsExpiresAt: null,
    score,
  };
}

// Full Tier-A row with all signals populated. PSI may have failed — that is
// recorded as fetchError at row-level (not a hard failure).
export function assembleAuditRow(
  candidate: PlaceCandidate,
  discovery: DiscoveryOutcome,
  now: Date,
  signals: GatheredSignals,
  psi: Awaited<ReturnType<typeof runPsiMobile>>,
  score: number,
  intentTier: IntentTier | null = "LIVE",
): UpsertAuditInput {
  const env = loadEnv();
  return {
    placeId: candidate.placeId,
    auditedAt: now,
    tier: "A",
    discoveredUrl: discovery.discoveredUrl,
    discoveryMethod: discovery.discoveryMethod,
    sslValid: signals.ssl.sslValid,
    sslExpiresAt: signals.ssl.sslExpiresAt,
    httpToHttpsRedirect: signals.ssl.httpToHttpsRedirect,
    hasViewportMeta: signals.viewport.hasViewportMeta,
    viewportMetaContent: signals.viewport.viewportMetaContent,
    psiMobilePerformance: psi.performance,
    psiMobileSeo: psi.seo,
    psiMobileAccessibility: psi.accessibility,
    psiMobileBestPractices: psi.bestPractices,
    psiFetchedAt: psi.fetchedAt,
    impressumUrl: signals.impressum.url,
    impressumPresent: signals.impressum.present,
    impressumUid: signals.impressum.uid,
    impressumCompanyName: signals.impressum.companyName,
    impressumAddress: signals.impressum.address,
    impressumPhone: signals.impressum.phone,
    impressumEmail: signals.impressum.email,
    impressumComplete: signals.impressum.complete,
    techStack: signals.tech,
    genericEmails: signals.impressum.email ? [signals.impressum.email] : [],
    socialLinks: signals.social,
    fetchError: psi.error,
    fetchErrorAt: psi.error ? now : null,
    intentTier,
    staticSignalsExpiresAt: new Date(
      now.getTime() + env.AUDIT_STATIC_TTL_DAYS * DAY_MS,
    ),
    psiSignalsExpiresAt: new Date(
      now.getTime() + env.AUDIT_PSI_TTL_DAYS * DAY_MS,
    ),
    score,
  };
}

export function buildRobotsDisallowedRow(
  candidate: PlaceCandidate,
  discovery: DiscoveryOutcome,
  now: Date,
): UpsertAuditInput {
  const base = buildEmptyTierRow(candidate, "A", discovery, now, "LIVE");
  return { ...base, fetchError: "ROBOTS_DISALLOWED", fetchErrorAt: now };
}
