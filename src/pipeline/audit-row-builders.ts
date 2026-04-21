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
import { sanitizeCompanyName } from "./sanitize-company-name.js";
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
  // FIX 11: last_modified year (or null if no signal). Populated by
  // detectLastModifiedYear in audit.ts:gatherSignals.
  lastModifiedSignal: number | null;
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
  // Tier-C normalisation: the upstream classifier (audit.ts:classifyIntentTier)
  // defaults tier='C' → intent_tier='DEAD', but 'DEAD' is not in the export
  // invariant's TIER_C_ALLOWED_INTENT_TIERS set, which causes the CSV export
  // to throw on any fetch-error row. Collapse the classifier default to 'NONE'
  // here. 'PARKED' (set explicitly by parking-detect) and the audit-error
  // labels ('AUDIT_ERROR', 'TIMEOUT') are preserved — they carry business
  // meaning a C-row needs to retain.
  const effectiveIntentTier: IntentTier | null =
    tier === "C" && intentTier === "DEAD" ? "NONE" : intentTier;
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
    intentTier: effectiveIntentTier,
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
    intentTier: effectiveIntentTier,
    staticSignalsExpiresAt: new Date(
      now.getTime() + env.AUDIT_STATIC_TTL_DAYS * DAY_MS,
    ),
    psiSignalsExpiresAt: null,
    score,
    // FIX 6 defaults: row is not a collapsed chain until apex-dedupe
    // actively re-writes these fields downstream.
    chainDetected: false,
    chainName: null,
    branchCount: 1,
    // FIX 11: empty-tier rows never run the last-modified detector
    // (no home body to scan), so the signal is null by construction.
    lastModifiedSignal: null,
    // #22: empty-tier rows never run detectSchemaOrg. `false` matches the
    // `hasStructuredData: false` passed into computeScore above, so the
    // stored score stays reproducible from the row.
    hasStructuredData: false,
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
    // Phase 7b Layer-C defense: `extractCompanyName` can still produce a
    // 100-char overflow when the match lives inside a single flat `<p>`
    // with no newline boundaries (see docs/investigations/name-leakage-
    // discovery.md §3e). The sanitizer trims at the first stop keyword,
    // caps length at 80, and returns null if nothing meaningful remains.
    impressumCompanyName: sanitizeCompanyName(signals.impressum.companyName),
    // Phase 6b wiring: when the impressum scraper returns no address, keep
    // the OSM candidate address so downstream (CSV PLZ filter, Bezirk
    // analytics) can still locate the business. `buildEmptyTierRow` already
    // did the equivalent for B3 rows; Tier-A rows silently dropped the
    // signal, which caused the 51→34 row loss in the Bezirk-1010 smoke.
    impressumAddress: signals.impressum.address ?? candidate.address,
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
    // FIX 6 defaults: Tier-A rows start life as non-collapsed; the apex
    // dedupe stage overwrites these for collapsed canonical rows.
    chainDetected: false,
    chainName: null,
    branchCount: 1,
    // FIX 11: carry the detector's verdict straight through. Null when
    // no cascade step produced a valid year.
    lastModifiedSignal: signals.lastModifiedSignal,
    // #22: persist the schema.org signal so the exporter no longer has
    // to infer it from the score gap.
    hasStructuredData: signals.schema.hasSchemaOrg,
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
