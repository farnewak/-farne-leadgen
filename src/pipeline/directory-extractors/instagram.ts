import type { CheerioAPI } from "cheerio";
import type { DirectoryExtractor } from "./types.js";
import { firstPublicUrl } from "./types.js";

// Instagram wraps external website links through l.instagram.com?u=<urlencoded>
// as a click-tracker. Decoding the `u` query param yields the clean URL.
function decodeLShimUrl(href: string | undefined): string | null {
  if (!href) return null;
  try {
    const u = new URL(href);
    if (!u.hostname.endsWith("l.instagram.com")) return null;
    const target = u.searchParams.get("u");
    return target ? decodeURIComponent(target) : null;
  } catch {
    return null;
  }
}

export const instagramExtractor: DirectoryExtractor = {
  id: "instagram",
  hostPattern: /^(www\.)?instagram\.com$/,
  extract(_html: string, $: CheerioAPI): string | null {
    const shimHref = $('a[href*="l.instagram.com/?u="]').attr("href");
    return firstPublicUrl([
      decodeLShimUrl(shimHref),
      $('header section a[target="_blank"]').first().attr("href"),
    ]);
  },
};
