import { load, type CheerioAPI } from "cheerio";
import type { SocialLinks } from "../models/audit.js";

// One regex per platform. Designed to ignore sharing URLs
// (facebook.com/sharer, twitter.com/intent, etc.) and pick only profile-style
// links. Sharing URLs live in article-action buttons on every WP/Drupal site
// and would otherwise pollute every audit.
interface PlatformRule {
  key: keyof SocialLinks;
  hostRegex: RegExp;
  // If present, the pathname must match — used to reject /sharer, /share, …
  pathReject?: RegExp;
  // If present, the pathname must be non-empty beyond a single "/"
  requireProfilePath?: boolean;
}

const RULES: PlatformRule[] = [
  {
    key: "facebook",
    hostRegex: /^(?:www\.|de-de\.|m\.)?facebook\.com$/i,
    pathReject: /^\/(?:sharer|share|plugins|dialog|tr|events\/shared)/i,
    requireProfilePath: true,
  },
  {
    key: "instagram",
    hostRegex: /^(?:www\.)?instagram\.com$/i,
    pathReject: /^\/(?:share|explore|p|reel)/i,
    requireProfilePath: true,
  },
  {
    key: "linkedin",
    hostRegex: /^(?:www\.|de\.)?linkedin\.com$/i,
    pathReject: /^\/(?:shareArticle|sharing|feed|pulse)/i,
    requireProfilePath: true,
  },
  {
    key: "xing",
    hostRegex: /^(?:www\.)?xing\.com$/i,
    pathReject: /^\/(?:app\/share|spi)/i,
    requireProfilePath: true,
  },
  {
    key: "twitter",
    hostRegex: /^(?:www\.)?(?:twitter|x)\.com$/i,
    pathReject: /^\/(?:intent|share|home)/i,
    requireProfilePath: true,
  },
  {
    key: "youtube",
    hostRegex: /^(?:www\.|m\.)?youtube\.com$/i,
    pathReject: /^\/(?:embed|watch|results)/i,
    requireProfilePath: true,
  },
  {
    key: "tiktok",
    hostRegex: /^(?:www\.)?tiktok\.com$/i,
    pathReject: /^\/(?:embed|tag|discover)/i,
    requireProfilePath: true,
  },
];

function classify(urlStr: string): keyof SocialLinks | null {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  const path = u.pathname;
  for (const rule of RULES) {
    if (!rule.hostRegex.test(host)) continue;
    if (rule.pathReject?.test(path)) continue;
    if (rule.requireProfilePath && (path === "/" || path === "")) continue;
    return rule.key;
  }
  return null;
}

export function extractSocialLinks(html: string): SocialLinks {
  if (!html) return {};
  const $ = load(html);
  return extractSocialLinksFromCheerio($);
}

export function extractSocialLinksFromCheerio(
  $: CheerioAPI,
): SocialLinks {
  const seen: Partial<Record<keyof SocialLinks, string>> = {};
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const key = classify(href.trim());
    if (!key) return;
    // First-seen-wins — footer/nav links are emitted before article embeds on
    // most templates, so the first match is typically the canonical profile.
    if (!seen[key]) {
      seen[key] = href.trim();
    }
  });
  return seen as SocialLinks;
}
