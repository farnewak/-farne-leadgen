import type { Tier, TechStackSignals, SocialLinks } from "../models/audit.js";

// Signed weights. Positive = "worse web presence", negative = "actively good".
// The clamp to [0, 30] at the bottom means best-case Tier-A sites floor at 0;
// anything in the negative band is a strong signal to skip outreach entirely.
export const SCORING_WEIGHTS = {
  NO_WEBSITE: 10,
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
}

// INVARIANT: For Tier B1/B2/B3/C, NO signal logic applies. The tier bucket
// itself is the signal — without a reachable website, signal values are
// unreliable and would mix apples/oranges with Tier-A scores.
export function computeScore(input: ScoreInput): number {
  let s = 0;

  if (input.tier === "B3") {
    s += SCORING_WEIGHTS.NO_WEBSITE;
  } else if (input.tier === "C") {
    s += SCORING_WEIGHTS.DEAD_WEBSITE;
  } else if (input.tier === "B1") {
    s += SCORING_WEIGHTS.ONLY_SOCIAL;
  } else if (input.tier === "B2") {
    s += SCORING_WEIGHTS.ONLY_DIRECTORY;
  } else if (input.tier === "A") {
    if (input.sslValid === false) s += SCORING_WEIGHTS.NO_SSL;
    if (input.httpToHttpsRedirect === false) s += SCORING_WEIGHTS.NO_HTTPS_REDIRECT;
    if (input.hasViewportMeta === false) s += SCORING_WEIGHTS.NO_MOBILE_VIEWPORT;

    // PSI bucket thresholds chosen to match Google's own labels:
    //   <50 = "Poor" (red), 50–74 = "Needs improvement" (orange),
    //   75–85 = "Good" but unremarkable (neutral),
    //   >85 = "Excellent" (green) — actively penalise our own lead score.
    const p = input.psiMobilePerformance;
    if (p !== null) {
      if (p < 50) s += SCORING_WEIGHTS.PSI_POOR;
      else if (p < 75) s += SCORING_WEIGHTS.PSI_MEDIUM;
      else if (p > 85) s += SCORING_WEIGHTS.PSI_EXCELLENT;
    }

    if (!input.impressumPresent) {
      s += SCORING_WEIGHTS.NO_IMPRESSUM;
    } else if (input.impressumComplete === false) {
      s += SCORING_WEIGHTS.IMPRESSUM_INCOMPLETE;
    }
    if (input.impressumPresent && !input.impressumUid) {
      s += SCORING_WEIGHTS.NO_UID;
    }

    if (input.techStack.cms.some((c) => BUDGET_CMS.has(c.toLowerCase()))) {
      s += SCORING_WEIGHTS.WIX_OR_JIMDO;
    }
    if (input.techStack.analytics.length === 0) s += SCORING_WEIGHTS.NO_ANALYTICS;
    if (input.techStack.tracking.length === 0) s += SCORING_WEIGHTS.NO_MODERN_TRACKING;
    if (Object.keys(input.socialLinks).length === 0) s += SCORING_WEIGHTS.NO_SOCIAL_LINKS;
    if (input.hasStructuredData) s += SCORING_WEIGHTS.HAS_STRUCTURED_DATA;
  }

  // Clamp: unbounded score would make sorting brittle when weights are tuned;
  // 0..30 keeps the CSV-export column comfortable and leaves room at the top.
  return Math.max(0, Math.min(30, s));
}
