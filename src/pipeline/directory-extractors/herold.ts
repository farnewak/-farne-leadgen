import type { CheerioAPI } from "cheerio";
import type { DirectoryExtractor } from "./types.js";
import { firstPublicUrl } from "./types.js";

export const heroldExtractor: DirectoryExtractor = {
  id: "herold",
  hostPattern: /^(www\.)?herold\.at$/,
  extract(_html: string, $: CheerioAPI): string | null {
    return firstPublicUrl([
      $('a[data-testid="website-link"]').attr("href"),
      $("a.website").attr("href"),
      $('meta[property="og:website"]').attr("content"),
    ]);
  },
};
