import { load, type CheerioAPI } from "cheerio";

export interface ViewportCheckResult {
  hasViewportMeta: boolean;
  viewportMetaContent: string | null;
}

// Matches <meta name="viewport" content="..."> case-insensitively. A missing
// viewport meta is the #1 indicator of a non-mobile-friendly site — tabs as
// "responsive" layout without it still render at desktop width on mobile.
export function checkViewport(html: string): ViewportCheckResult {
  if (!html) return { hasViewportMeta: false, viewportMetaContent: null };
  const $ = load(html);
  return checkViewportFromCheerio($);
}

export function checkViewportFromCheerio(
  $: CheerioAPI,
): ViewportCheckResult {
  const meta = $('meta[name="viewport"]').first();
  if (meta.length === 0) {
    return { hasViewportMeta: false, viewportMetaContent: null };
  }
  const content = meta.attr("content")?.trim() ?? "";
  return {
    hasViewportMeta: true,
    viewportMetaContent: content.length > 0 ? content : null,
  };
}
