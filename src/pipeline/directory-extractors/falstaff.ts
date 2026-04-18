import type { CheerioAPI } from "cheerio";
import type { DirectoryExtractor } from "./types.js";
import { firstPublicUrl } from "./types.js";

export const falstaffExtractor: DirectoryExtractor = {
  id: "falstaff",
  hostPattern: /^(www\.)?falstaff\.at$/,
  extract(_html: string, $: CheerioAPI): string | null {
    return firstPublicUrl([
      $(".restaurant-info a.website").attr("href"),
      $('dt:contains("Website") + dd a').attr("href"),
    ]);
  },
};
