import { load, type CheerioAPI } from "cheerio";
import type { ImpressumData } from "../models/audit.js";
import { fetchUrl } from "../lib/http-fetch.js";
import {
  extractUid,
  extractPhone,
  extractAustriaAddress,
  extractCompanyName,
} from "./impressum-parsers.js";
import { isGenericBusinessEmail } from "./email-filter.js";

// Candidate paths for the Impressum page, in priority order. Austrian sites
// overwhelmingly use /impressum; the rest are hedges against English-language
// SMEs and CMS defaults that put the imprint behind /legal or /kontakt.
export const IMPRESSUM_PATHS = [
  "/impressum",
  "/imprint",
  "/legal",
  "/kontakt",
  "/about",
  "/ueber-uns",
] as const;

// 20s total deadline. Each individual fetch uses a shorter per-request cap;
// this is a belt-and-braces guard against a site that responds slowly for
// every candidate path.
const TOTAL_DEADLINE_MS = 20_000;
const PER_FETCH_TIMEOUT_MS = 7_000;

const EMAIL_REGEX = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;

function absUrl(base: string, href: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

// Footer-link discovery. Many Austrian sites only expose Impressum in the
// footer; scanning the whole DOM for any anchor whose text OR href hints at
// Impressum is reliable and cheap.
function findImpressumLinksInDom(
  $: CheerioAPI,
  baseUrl: string,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const text = $(el).text().toLowerCase().trim();
    const hrefLower = href.toLowerCase();
    const looksImpressum =
      text.includes("impressum") ||
      text.includes("imprint") ||
      hrefLower.includes("impressum") ||
      hrefLower.includes("imprint");
    if (!looksImpressum) return;
    const abs = absUrl(baseUrl, href);
    if (!abs) return;
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push(abs);
  });
  return out;
}

function extractGenericEmail($: CheerioAPI, text: string): string | null {
  // Prefer mailto: links — less false positives than regex on body text.
  let found: string | null = null;
  $('a[href^="mailto:"]').each((_, el) => {
    if (found) return;
    const href = $(el).attr("href") ?? "";
    const mail = href.replace(/^mailto:/i, "").split("?")[0]?.trim();
    if (mail && isGenericBusinessEmail(mail)) found = mail;
  });
  if (found) return found;

  const matches = text.match(EMAIL_REGEX);
  if (!matches) return null;
  for (const candidate of matches) {
    if (isGenericBusinessEmail(candidate)) return candidate;
  }
  return null;
}

function parseImpressumHtml(
  html: string,
  url: string,
): ImpressumData {
  const $ = load(html);
  // Limit text scan to the body — avoids picking up analytics comments or
  // meta content that happens to contain UID-like numbers.
  const bodyText = $("body").text();
  const uid = extractUid(bodyText);
  const phone = extractPhone(bodyText);
  const address = extractAustriaAddress(bodyText);
  const companyName = extractCompanyName(bodyText);
  const email = extractGenericEmail($, bodyText);

  // Impressum is "complete" when the DSGVO-relevant fields are filled: UID,
  // company name, address. Phone/email are nice-to-have but legally optional.
  const complete = Boolean(uid && companyName && address);

  return {
    present: true,
    url,
    uid,
    companyName,
    address,
    phone,
    email,
    complete,
  };
}

function emptyImpressum(): ImpressumData {
  return {
    present: false,
    url: null,
    uid: null,
    companyName: null,
    address: null,
    phone: null,
    email: null,
    complete: false,
  };
}

// Two-stage discovery: (1) scan the home page for footer links pointing to
// /impressum — handles CMS templates that put it in the footer only. (2) fall
// back to IMPRESSUM_PATHS heuristics. Stops at the first 200 OK with a body.
export async function fetchAndParseImpressum(
  siteUrl: string,
): Promise<ImpressumData> {
  const started = Date.now();
  const budgetLeft = (): number =>
    Math.max(0, TOTAL_DEADLINE_MS - (Date.now() - started));

  const home = await fetchUrl(siteUrl, {
    timeoutMs: Math.min(PER_FETCH_TIMEOUT_MS, budgetLeft() || 1),
    retries: 0,
  });

  const candidates: string[] = [];
  if (home.status === 200 && home.body) {
    const $ = load(home.body);
    for (const link of findImpressumLinksInDom($, home.finalUrl || siteUrl)) {
      candidates.push(link);
    }
  }

  // Fallback: conventional paths. Keep a seen-set so DOM-discovered links
  // that happen to equal "/impressum" aren't re-fetched.
  const seen = new Set(candidates);
  for (const path of IMPRESSUM_PATHS) {
    const abs = absUrl(siteUrl, path);
    if (abs && !seen.has(abs)) {
      candidates.push(abs);
      seen.add(abs);
    }
  }

  for (const candidate of candidates) {
    if (budgetLeft() <= 0) break;
    const res = await fetchUrl(candidate, {
      timeoutMs: Math.min(PER_FETCH_TIMEOUT_MS, budgetLeft() || 1),
      retries: 0,
    });
    if (res.status === 200 && res.body.length > 0) {
      return parseImpressumHtml(res.body, res.finalUrl || candidate);
    }
  }

  return emptyImpressum();
}

// Exported for unit tests that want to exercise the pure parse layer without
// going through the network.
export { parseImpressumHtml };
