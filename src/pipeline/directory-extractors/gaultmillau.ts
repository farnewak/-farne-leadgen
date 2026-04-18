import type { CheerioAPI } from "cheerio";
import type { DirectoryExtractor } from "./types.js";
import { firstPublicUrl } from "./types.js";

export const gaultmillauExtractor: DirectoryExtractor = {
  id: "gaultmillau",
  hostPattern: /^(www\.)?gaultmillau\.at$/,
  extract(_html: string, $: CheerioAPI): string | null {
    return firstPublicUrl([
      $('.restaurant-details a[href*="http"]').first().attr("href"),
    ]);
  },
};
