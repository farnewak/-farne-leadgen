import type { CheerioAPI } from "cheerio";
import type { DirectoryExtractor } from "./types.js";
import { firstPublicUrl } from "./types.js";

const WEBSITE_RE = /"website":"(https?:\/\/[^"]+)"/;

export const facebookExtractor: DirectoryExtractor = {
  id: "facebook",
  hostPattern: /^(www\.)?facebook\.com$/,
  extract(html: string, $: CheerioAPI): string | null {
    const selectorHits: Array<string | undefined> = [
      $('a[aria-label*="Website"]').attr("href"),
      $('div[data-key="website"] a').attr("href"),
    ];
    // Facebook renders pages as React JSON blobs — the DOM selectors cover
    // the classic business-page layout; the regex is a fallback against
    // JSON payloads that never hydrate into real `<a>` elements.
    const m = html.match(WEBSITE_RE);
    if (m?.[1]) selectorHits.push(m[1]);
    return firstPublicUrl(selectorHits);
  },
};
