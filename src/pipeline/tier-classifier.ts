import type { FetchError, Tier } from "../models/audit.js";

export interface TierInput {
  hasDiscoveredUrl: boolean;
  fetchError: FetchError | null;
  socialLinksCount: number;
  directoryHitsCount: number;
}

// Tier-C = "we know a site exists, but it's broken in a scoreable way".
// CERT_EXPIRED, HTTP_5XX, DNS_FAIL are the three errors that indicate real
// neglect (not transient 429s or random 4xx permission pages).
const TIER_C_ERRORS: readonly FetchError[] = [
  "CERT_EXPIRED",
  "HTTP_5XX",
  "DNS_FAIL",
];

// Pure decision table — order matters:
//   A  : site reachable, no fetch error → primary outreach target
//   C  : site exists-but-broken → strongest "cold" pitch angle
//   B1 : no site, but owns social → outreach via social mention
//   B2 : no site, no social, only in directories → directory-based intro
//   B3 : invisible on the web → lowest-quality lead, still worth a CSV row
export function classifyTier(input: TierInput): Tier {
  if (input.hasDiscoveredUrl && !input.fetchError) return "A";
  if (
    input.hasDiscoveredUrl &&
    input.fetchError &&
    TIER_C_ERRORS.includes(input.fetchError)
  ) {
    return "C";
  }
  if (input.socialLinksCount > 0) return "B1";
  if (input.directoryHitsCount > 0) return "B2";
  return "B3";
}
