import type {
  Tier,
  IntentTier,
  TechStackSignals,
  SocialLinks,
} from "../models/audit.js";

// FIX 7 — market-weakness anchor. NO_WEBSITE must outrank every realistic
// Tier-A record so that "no web presence at all" always sorts above any
// in-market shop with degraded signals. Current realistic Tier-A maximum is
// ≈14 (Phase 2A field samples), theoretical maximum is 19 (all Tier-A
// positive weights summed). 20 leaves 6-point headroom; if a future penalty
// lifts the Tier-A ceiling to >=19, raise this constant and re-document in
// ARCHITECTURE_MAP.md > "Scoring rules". Exported so the property-based
// test and assertExportInvariants can anchor on it directly.
export const NO_WEBSITE_PENALTY = 20;

// Signed weights. Positive = "worse web presence", negative = "actively good".
// The clamp to [0, 30] at the bottom means best-case Tier-A sites floor at 0;
// anything in the negative band is a strong signal to skip outreach entirely.
export const SCORING_WEIGHTS = {
  NO_WEBSITE: NO_WEBSITE_PENALTY,
  // Domain registered but only a parking page served. Ranked above
  // NO_WEBSITE/DEAD_WEBSITE because the owner already spent money on the
  // domain and signalled purchase intent. Replaces DEAD_WEBSITE for
  // C-rows with intent_tier=PARKED (see scoreBreakdown below). Lifted
  // alongside NO_WEBSITE in FIX 7 to preserve the PARKED > NO_WEBSITE
  // business invariant.
  DOMAIN_REGISTERED_NO_SITE: NO_WEBSITE_PENALTY + 2,
  DEAD_WEBSITE: 9,
  ONLY_SOCIAL: 7,
  ONLY_DIRECTORY: 6,
  NO_SSL: 3,
  NO_HTTPS_REDIRECT: 2,
  NO_MOBILE_VIEWPORT: 3,
  PSI_POOR: 3,
  PSI_MEDIUM: 1,
  NO_IMPRESSUM: 3,
  IMPRESSUM_INCOMPLETE: 2,
  NO_UID: 1,
  WIX_OR_JIMDO: 2,
  NO_ANALYTICS: 1,
  NO_MODERN_TRACKING: 1,
  NO_SOCIAL_LINKS: 1,
  HAS_STRUCTURED_DATA: -1,
  PSI_EXCELLENT: -1,
} as const;

export type ScoreWeightKey = keyof typeof SCORING_WEIGHTS;

export interface BreakdownEntry {
  key: ScoreWeightKey;
  delta: number;
}

// Tech-stack CMS identifiers considered "budget-tier" for outreach purposes.
// Wix/Jimdo sites are cheaper to migrate and more likely to need our help —
// they're a positive signal, not a negative judgement of the tool itself.
const BUDGET_CMS = new Set(["wix", "jimdo"]);

export interface ScoreInput {
  tier: Tier;
  sslValid: boolean | null;
  httpToHttpsRedirect: boolean | null;
  hasViewportMeta: boolean | null;
  psiMobilePerformance: number | null;
  impressumPresent: boolean;
  impressumComplete: boolean | null;
  impressumUid: string | null;
  techStack: TechStackSignals;
  socialLinks: SocialLinks;
  hasStructuredData: boolean;
  // Optional. When set to "PARKED" on a tier-C row, DOMAIN_REGISTERED_NO_SITE
  // replaces DEAD_WEBSITE in the breakdown. All other intent-tier values and
  // all other tiers are unaffected by this field.
  intentTier?: IntentTier | null;
}

// Returns the list of signals that contributed to the score, in the same
// order they were evaluated. Used both by computeScore() (sum + clamp) and
// by the CSV exporter (human-readable breakdown column).
//
// INVARIANT: For Tier B1/B2/B3/C, NO signal logic applies. The tier bucket
// itself is the signal — without a reachable website, signal values are
// unreliable and would mix apples/oranges with Tier-A scores.
export function scoreBreakdown(input: ScoreInput): BreakdownEntry[] {
  const out: BreakdownEntry[] = [];
  const push = (key: ScoreWeightKey): void => {
    out.push({ key, delta: SCORING_WEIGHTS[key] });
  };

  if (input.tier === "B3") {
    push("NO_WEBSITE");
    return out;
  }
  if (input.tier === "C") {
    if (input.intentTier === "PARKED") push("DOMAIN_REGISTERED_NO_SITE");
    else push("DEAD_WEBSITE");
    return out;
  }
  if (input.tier === "B1") {
    push("ONLY_SOCIAL");
    return out;
  }
  if (input.tier === "B2") {
    push("ONLY_DIRECTORY");
    return out;
  }

  // Tier A — evaluate every signal.
  if (input.sslValid === false) push("NO_SSL");
  if (input.httpToHttpsRedirect === false) push("NO_HTTPS_REDIRECT");
  if (input.hasViewportMeta === false) push("NO_MOBILE_VIEWPORT");

  // PSI bucket thresholds chosen to match Google's own labels:
  //   <50 = "Poor" (red), 50–74 = "Needs improvement" (orange),
  //   75–85 = "Good" but unremarkable (neutral),
  //   >85 = "Excellent" (green) — actively penalise our own lead score.
  const p = input.psiMobilePerformance;
  if (p !== null) {
    if (p < 50) push("PSI_POOR");
    else if (p < 75) push("PSI_MEDIUM");
    else if (p > 85) push("PSI_EXCELLENT");
  }

  if (!input.impressumPresent) {
    push("NO_IMPRESSUM");
  } else if (input.impressumComplete === false) {
    push("IMPRESSUM_INCOMPLETE");
  }
  if (input.impressumPresent && !input.impressumUid) push("NO_UID");

  if (input.techStack.cms.some((c) => BUDGET_CMS.has(c.toLowerCase()))) {
    push("WIX_OR_JIMDO");
  }
  if (input.techStack.analytics.length === 0) push("NO_ANALYTICS");
  if (input.techStack.tracking.length === 0) push("NO_MODERN_TRACKING");
  if (Object.keys(input.socialLinks).length === 0) push("NO_SOCIAL_LINKS");
  if (input.hasStructuredData) push("HAS_STRUCTURED_DATA");

  return out;
}

export function computeScore(input: ScoreInput): number {
  const entries = scoreBreakdown(input);
  const sum = entries.reduce((acc, e) => acc + e.delta, 0);
  // Clamp: unbounded score would make sorting brittle when weights are tuned;
  // 0..30 keeps the CSV-export column comfortable and leaves room at the top.
  return Math.max(0, Math.min(30, sum));
}
