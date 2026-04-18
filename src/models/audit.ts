import { z } from "zod";

export const TIERS = ["A", "B1", "B2", "B3", "C"] as const;
export type Tier = (typeof TIERS)[number];

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
