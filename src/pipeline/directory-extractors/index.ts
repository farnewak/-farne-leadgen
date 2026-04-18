import { heroldExtractor } from "./herold.js";
import { firmenabcExtractor } from "./firmenabc.js";
import { wkoExtractor } from "./wko.js";
import { facebookExtractor } from "./facebook.js";
import { instagramExtractor } from "./instagram.js";
import { falstaffExtractor } from "./falstaff.js";
import { gaultmillauExtractor } from "./gaultmillau.js";
import type { DirectoryExtractor } from "./types.js";

export { isBlacklistedHost, normalizeUrl, firstPublicUrl } from "./types.js";
export type { DirectoryExtractor } from "./types.js";

export const EXTRACTORS: readonly DirectoryExtractor[] = [
  heroldExtractor,
  firmenabcExtractor,
  wkoExtractor,
  facebookExtractor,
  instagramExtractor,
  falstaffExtractor,
  gaultmillauExtractor,
] as const;

export function pickExtractor(url: string): DirectoryExtractor | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return EXTRACTORS.find((e) => e.hostPattern.test(host)) ?? null;
  } catch {
    return null;
  }
}
