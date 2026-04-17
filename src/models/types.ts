import { z } from "zod";

export const INDUSTRIES = [
  "gastronomy",
  "retail",
  "services",
  "health",
  "beauty",
  "crafts",
  "other",
] as const;
export type Industry = (typeof INDUSTRIES)[number];

export const LEAD_STATUSES = [
  "new",
  "contacted",
  "qualified",
  "proposal",
  "won",
  "lost",
  "dismissed",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const CHAIN_FLAGS = ["blocklisted", "suspected_chain"] as const;
export type ChainFlag = (typeof CHAIN_FLAGS)[number];

export const CONTACT_SOURCES = ["impressum", "gbp", "homepage"] as const;
export type ContactSource = (typeof CONTACT_SOURCES)[number];

export interface PlaceCandidate {
  placeId: string;
  name: string;
  address: string | null;
  plz: string | null;
  district: string | null;
  types: string[];
  primaryType: string | null;
  website: string | null;
  phone: string | null;
  lat: number;
  lng: number;
}

export interface AuditSignals {
  lighthouseMobile: number | null;
  lighthouseDesktop: number | null;
  hasReservation: boolean | null;
  hasShop: boolean | null;
  techStack: string[];
  sslValid: boolean | null;
  socialLastPostAt: number | null;
  visionVerdict: string | null;
}

export const OpportunitySnippetSchema = z
  .string()
  .min(20, "Snippet zu kurz — mindestens 20 Zeichen")
  .max(140, "Snippet > 140 Zeichen — E-Mail-Subject-untauglich")
  .refine((s) => !s.includes("!"), "Keine Ausrufezeichen erlaubt")
  .refine((s) => !/\b(du|dein|deine|dir|dich)\b/i.test(s), "Muss Sie-Form sein");

export const OpportunityOutputSchema = z.object({
  opportunity: z.array(OpportunitySnippetSchema).min(1).max(3),
});
export type OpportunityOutput = z.infer<typeof OpportunityOutputSchema>;
