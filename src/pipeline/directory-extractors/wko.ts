import type { CheerioAPI } from "cheerio";
import type { DirectoryExtractor } from "./types.js";
import { firstPublicUrl } from "./types.js";

// JSON-LD in WKO firmen-directory pages nests the website URL under either
// `url` on the Organization root or a sameAs array. Parsing is defensive:
// malformed JSON blocks are skipped, not thrown.
function extractFromJsonLd(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    const nodes = Array.isArray(parsed) ? parsed : [parsed];
    const urls: string[] = [];
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const rec = node as Record<string, unknown>;
      if (typeof rec.url === "string") urls.push(rec.url);
      if (Array.isArray(rec.sameAs)) {
        for (const s of rec.sameAs) {
          if (typeof s === "string") urls.push(s);
        }
      }
    }
    return urls;
  } catch {
    return [];
  }
}

export const wkoExtractor: DirectoryExtractor = {
  id: "wko",
  hostPattern: /^firmen\.wko\.at$/,
  extract(_html: string, $: CheerioAPI): string | null {
    const candidates: string[] = [];
    $('script[type="application/ld+json"]').each((_, el) => {
      const raw = $(el).text();
      candidates.push(...extractFromJsonLd(raw));
    });
    return firstPublicUrl(candidates);
  },
};
