import { z } from "zod";

export const TIERS = ["A", "B1", "B2", "B3", "C"] as const;
export type Tier = (typeof TIERS)[number];

// Intent-tier is orthogonal to the A/B1/B2/B3/C bucketing and captures the
// domain-level signal rather than the site-quality signal:
//   LIVE   = tier A with a real, non-parked site.
//   PARKED = a registered domain with only a parking page — HIGH-intent lead.
//            Always paired with tier=C (the site is effectively dead despite
//            returning HTTP 200). Outranks LIVE because the owner has
//            already paid for the domain and signalled purchase readiness.
//   DEAD   = tier C caused by fetch error (cert/5xx/DNS) — no parking page.
//   NONE   = no URL to probe (tier B1/B2/B3) OR not yet classified.
// v0.1 schema adds this as a nullable column; historical rows migrate to
// NULL and are populated on re-audit.
export const INTENT_TIERS = ["PARKED", "DEAD", "LIVE", "NONE"] as const;
export type IntentTier = (typeof INTENT_TIERS)[number];

export const DISCOVERY_METHODS = [
  "osm-tag",
  "gplaces-tag",
  "dns-probe",
  "cse",
  "manual",
] as const;
export type DiscoveryMethod = (typeof DISCOVERY_METHODS)[number];

// Classifies fetch failures so the scorer can distinguish "site never existed"
// from "site exists but is currently down". FETCH_ERRORS are intentionally
// coarse — SCRAPER_* specifics belong in `fetchError` free-text if ever needed.
export const FETCH_ERRORS = [
  "DNS_FAIL",
  "TIMEOUT",
  "HTTP_5XX",
  "HTTP_4XX",
  "CERT_EXPIRED",
  "CERT_INVALID",
  "SSL_HANDSHAKE",
  "CONNECTION_REFUSED",
  // PSI / upstream-API specific classifications. Added in B4: the PSI
  // integration distinguishes quota exhaustion from auth failure from
  // transient 5xx so retry policy and DB negative-cache can differ.
  "RATE_LIMITED",
  "AUTH_ERROR",
  "QUOTA_EXCEEDED",
  "SERVER_ERROR",
  "CLIENT_ERROR",
  // robots.txt disallow for the discovered URL path. Tier stays A but the
  // signals layer is skipped to honour the site's stated crawl policy.
  "ROBOTS_DISALLOWED",
  "UNKNOWN",
] as const;
export type FetchError = (typeof FETCH_ERRORS)[number];

// Six tech-stack buckets. Keeps the scorer agnostic to individual vendors
// (a WordPress lead and a Joomla lead both look like `cms:[x]`).
export const TechStackSignalsSchema = z.object({
  cms: z.array(z.string()).default([]),
  pageBuilder: z.array(z.string()).default([]),
  analytics: z.array(z.string()).default([]),
  tracking: z.array(z.string()).default([]),
  payment: z.array(z.string()).default([]),
  cdn: z.array(z.string()).default([]),
});
export type TechStackSignals = z.infer<typeof TechStackSignalsSchema>;

export const SocialLinksSchema = z.object({
  facebook: z.string().url().optional(),
  instagram: z.string().url().optional(),
  linkedin: z.string().url().optional(),
  xing: z.string().url().optional(),
  twitter: z.string().url().optional(),
  youtube: z.string().url().optional(),
  tiktok: z.string().url().optional(),
});
export type SocialLinks = z.infer<typeof SocialLinksSchema>;

// Austrian VAT-ID (UID) pattern: ATU followed by exactly 8 digits.
// Impressum-scraper validates against this before persisting.
export const ImpressumDataSchema = z.object({
  present: z.boolean(),
  url: z.string().url().nullable(),
  uid: z
    .string()
    .regex(/^ATU\d{8}$/)
    .nullable(),
  companyName: z.string().nullable(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().email().nullable(),
  complete: z.boolean(),
});
export type ImpressumData = z.infer<typeof ImpressumDataSchema>;
