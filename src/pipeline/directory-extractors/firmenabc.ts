import type { CheerioAPI } from "cheerio";
import type { DirectoryExtractor } from "./types.js";
import { firstPublicUrl } from "./types.js";

export const firmenabcExtractor: DirectoryExtractor = {
  id: "firmenabc",
  hostPattern: /^(www\.)?firmenabc\.at$/,
  extract(_html: string, $: CheerioAPI): string | null {
    return firstPublicUrl([
      $(".company-website a").attr("href"),
      $('a[rel="external noopener"][href^="http"]').first().attr("href"),
    ]);
  },
};
