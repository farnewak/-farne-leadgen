// Aggressive Impressum scraper for P0 contact-coverage.
//
// Spec §C:
//   I1  only runs when a website URL is known
//   I2  candidate path priority (first 200-OK wins)
//   I3  delegate email extraction + noise filter to ./email-extract.ts
//   I4  phone normalised to E.164 via libphonenumber-js
//   I5  address ONLY accepted with strict Vienna PLZ (1010–1230 step 10)
//   I6  per-domain file cache, 7-day TTL
//   I7  8s budget, max 3 pages per domain (no spider)
//   I8  returned coverage flag "P"/"E"/"A"/… lets caller fill CSV
//   I9  UA "farne-leadgen/1.0 …"; robots.txt fail-closed on Disallow
//
// Anti-malware note: same as email-extract — only touches publicly-required
// Austrian Impressum pages for documented B2B lead generation.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { load, type CheerioAPI } from "cheerio";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { loadEnv } from "../../lib/env.js";
import { makeLogger } from "../../lib/logger.js";
import { fetchUrl } from "../../lib/http-fetch.js";
import { getRobotsRules } from "../../pipeline/robots.js";
import { extractCompanyName, extractUid } from "../../pipeline/impressum-parsers.js";
import {
  extractEmails,
  extractMailtoEmails,
  prioritizeEmails,
} from "./email-extract.js";

const log = makeLogger("impressum-scraper");

const DAY_MS = 24 * 60 * 60 * 1000;

// Spec §C I2 — priority order as given (different from the older
// IMPRESSUM_PATHS in src/pipeline/impressum.ts on purpose: "kontakt" now
// ranks above "legal" because Austrian SMEs that don't publish under
// /impressum overwhelmingly use /kontakt).
export const SCRAPER_PATHS = [
  "/impressum",
  "/imprint",
  "/kontakt",
  "/contact",
  "/legal",
  "/about",
  "/ueber-uns",
] as const;

export const SCRAPER_USER_AGENT =
  "farne-leadgen/1.0 (Wien local business research)";

const TOTAL_DEADLINE_MS = 8_000;
const PER_FETCH_TIMEOUT_MS = 5_000;
const MAX_PAGES_PER_DOMAIN = 3;

export type CoverageFlag = "" | "P" | "E" | "A" | "PE" | "PA" | "EA" | "PEA";

export interface ScrapedContact {
  impressumUrl: string | null;
  email: string | null;
  emails: string[];
  phone: string | null;
  address: string | null;
  plz: string | null;
  companyName: string | null;
  uid: string | null;
  coverage: CoverageFlag;
  cacheHit: boolean;
  robotsBlocked: boolean;
}

export interface ScrapeOptions {
  cacheDir?: string;
  cacheTtlDays?: number;
  now?: () => Date;
  // Test hooks
  fetch?: typeof fetchUrl;
  getRobotsRules?: typeof getRobotsRules;
}

interface CacheEntry {
  createdAt: number;
  url: string;
  data: Omit<ScrapedContact, "cacheHit">;
}

export function emptyContact(): ScrapedContact {
  return {
    impressumUrl: null,
    email: null,
    emails: [],
    phone: null,
    address: null,
    plz: null,
    companyName: null,
    uid: null,
    coverage: "",
    cacheHit: false,
    robotsBlocked: false,
  };
}

function domainKey(siteUrl: string): string {
  try {
    const host = new URL(siteUrl).host.toLowerCase().replace(/^www\./, "");
    return createHash("sha256").update(host).digest("hex");
  } catch {
    return createHash("sha256").update(siteUrl).digest("hex");
  }
}

function cacheFile(cacheDir: string, key: string): string {
  return join(cacheDir, `${key}.json`);
}

async function readCache(
  cacheDir: string,
  key: string,
): Promise<CacheEntry | null> {
  try {
    const raw = await readFile(cacheFile(cacheDir, key), "utf8");
    return JSON.parse(raw) as CacheEntry;
  } catch {
    return null;
  }
}

async function writeCache(
  cacheDir: string,
  key: string,
  entry: CacheEntry,
): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cacheFile(cacheDir, key), JSON.stringify(entry), "utf8");
}

function absUrl(base: string, href: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

// Scan the DOM for anchors whose text or href hints at Impressum/Kontakt.
// Cheap but effective: many CMS templates only surface the imprint via
// footer links and skip /impressum entirely.
function findImpressumLinks($: CheerioAPI, baseUrl: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const text = $(el).text().toLowerCase().trim();
    const hrefLower = href.toLowerCase();
    const hit =
      text.includes("impressum") ||
      text.includes("imprint") ||
      text.includes("kontakt") ||
      hrefLower.includes("impressum") ||
      hrefLower.includes("imprint") ||
      hrefLower.includes("kontakt");
    if (!hit) return;
    const abs = absUrl(baseUrl, href);
    if (!abs) return;
    if (seen.has(abs)) return;
    seen.add(abs);
    out.push(abs);
  });
  return out;
}

// Vienna PLZ strict: 1010, 1020, …, 1230 (10-step). Values like 1121 or
// 1300 exist in other registries but are NOT valid Wien-PLZs and would
// signal that the extracted address belongs to a branch outside the
// audit scope — better to reject than to propagate low-quality data.
function isValidViennaPlz(plz: string): boolean {
  if (!/^1\d{3}$/.test(plz)) return false;
  const n = Number(plz);
  if (n < 1010 || n > 1230) return false;
  return n % 10 === 0;
}

// Address heuristic tuned for Wiener Impressum layouts. Requires a
// street+number token followed by a PLZ+city, separated by comma or
// whitespace. PLZ is validated strictly (I5).
const ADDRESS_REGEX =
  /([A-ZÄÖÜ][\wÄÖÜäöüß.\- ]{2,60}?\s+\d{1,4}[a-zA-Z]?(?:\s*[-/]\s*\d{1,4})?)[,\s]+(\d{4})\s+([A-ZÄÖÜ][\wÄÖÜäöüß .\-]{2,60})/;

function extractStrictAddress(text: string): {
  address: string | null;
  plz: string | null;
} {
  const normalized = text.replace(/\s+/g, " ").trim();
  const m = normalized.match(ADDRESS_REGEX);
  if (!m) return { address: null, plz: null };
  const [, street, plz, city] = m;
  if (!street || !plz || !city) return { address: null, plz: null };
  if (!isValidViennaPlz(plz)) {
    // I5: Invalid PLZ → reject the entire address. The data quality gate
    // is intentional; a Niederösterreich branch address for a Vienna
    // candidate is worse than no address.
    return { address: null, plz: null };
  }
  return { address: `${street.trim()}, ${plz} ${city.trim()}`, plz };
}

// Austrian phone-number extraction + E.164 normalisation.
// Grabs any digit-shaped token that looks like a phone number, hands it
// to libphonenumber-js with AT region, accepts the first valid parse.
const PHONE_CANDIDATE_REGEX =
  /(?:\+\s*43|0043|\b0)[\s\-/().\d]{6,24}\d/g;

export function normalizeAustrianPhone(raw: string): string | null {
  const parsed = parsePhoneNumberFromString(raw, "AT");
  if (!parsed || !parsed.isValid()) return null;
  if (parsed.country !== "AT") return null;
  return parsed.number; // E.164
}

function extractPhoneE164($: CheerioAPI, text: string): string | null {
  // Prefer tel: hrefs — explicit author intent.
  let found: string | null = null;
  $('a[href^="tel:"]').each((_, el) => {
    if (found) return;
    const href = $(el).attr("href") ?? "";
    const value = href.replace(/^tel:/i, "");
    const e164 = normalizeAustrianPhone(value);
    if (e164) found = e164;
  });
  if (found) return found;

  const candidates = text.match(PHONE_CANDIDATE_REGEX);
  if (!candidates) return null;
  for (const raw of candidates) {
    const e164 = normalizeAustrianPhone(raw);
    if (e164) return e164;
  }
  return null;
}

function buildCoverage(
  phone: string | null,
  email: string | null,
  address: string | null,
): CoverageFlag {
  const p = phone ? "P" : "";
  const e = email ? "E" : "";
  const a = address ? "A" : "";
  return (p + e + a) as CoverageFlag;
}

export interface ParsedPage {
  email: string | null;
  emails: string[];
  phone: string | null;
  address: string | null;
  plz: string | null;
  companyName: string | null;
  uid: string | null;
}

// Pure parse step. Split from the fetcher so unit tests can feed HTML
// fixtures directly.
export function parseImpressumPage(html: string): ParsedPage {
  const $ = load(html);
  const body = $("body").text();
  const bodyHtml = $("body").html() ?? html;

  // Email extraction: merge mailto: anchors + body-text regex, dedupe.
  const mailtoHrefs: string[] = [];
  $('a[href^="mailto:"]').each((_, el) => {
    const h = $(el).attr("href");
    if (h) mailtoHrefs.push(h);
  });
  const mailtoEmails = extractMailtoEmails(mailtoHrefs);
  const textEmails = extractEmails(bodyHtml);
  const merged = [...mailtoEmails, ...textEmails];
  const dedup: string[] = [];
  const seenE = new Set<string>();
  for (const e of merged) {
    if (seenE.has(e)) continue;
    seenE.add(e);
    dedup.push(e);
  }
  const emails = prioritizeEmails(dedup);

  const phone = extractPhoneE164($, body);
  const addr = extractStrictAddress(body);
  const companyName = extractCompanyName(body);
  const uid = extractUid(body);

  return {
    email: emails[0] ?? null,
    emails,
    phone,
    address: addr.address,
    plz: addr.plz,
    companyName,
    uid,
  };
}

function mergeParsed(
  acc: ParsedPage,
  next: ParsedPage,
): ParsedPage {
  const emails = prioritizeEmails(
    Array.from(new Set([...acc.emails, ...next.emails])),
  );
  return {
    email: acc.email ?? next.email ?? emails[0] ?? null,
    emails,
    phone: acc.phone ?? next.phone,
    address: acc.address ?? next.address,
    plz: acc.plz ?? next.plz,
    companyName: acc.companyName ?? next.companyName,
    uid: acc.uid ?? next.uid,
  };
}

// Main entry. Budget-bounded fetch loop that visits at most 3 URLs:
//   1. Home page (used both to discover footer links AND as a parse source
//      — many sites publish phone/email on the landing page directly).
//   2. First Impressum candidate URL.
//   3. Best fallback (/kontakt or next path from SCRAPER_PATHS).
export async function scrapeImpressum(
  siteUrl: string,
  opts: ScrapeOptions = {},
): Promise<ScrapedContact> {
  const env = loadEnv();
  const cacheDir = opts.cacheDir ?? env.IMPRESSUM_CACHE_DIR;
  const ttlDays = opts.cacheTtlDays ?? env.IMPRESSUM_CACHE_TTL_DAYS;
  const now = (opts.now ?? (() => new Date()))();
  const fetchFn = opts.fetch ?? fetchUrl;
  const robotsFn = opts.getRobotsRules ?? getRobotsRules;

  const key = domainKey(siteUrl);
  const cached = await readCache(cacheDir, key);
  if (cached && now.getTime() - cached.createdAt < ttlDays * DAY_MS) {
    return { ...cached.data, cacheHit: true };
  }

  let origin: string;
  try {
    origin = new URL(siteUrl).origin;
  } catch {
    return emptyContact();
  }

  // I9: robots.txt is authoritative. Fail-closed on explicit Disallow
  // for any of our candidate paths — we refuse to fetch.
  const robots = await robotsFn(origin);

  const started = Date.now();
  const budgetLeft = (): number =>
    Math.max(0, TOTAL_DEADLINE_MS - (Date.now() - started));

  const visited = new Set<string>();
  let pagesUsed = 0;
  let best: ParsedPage = {
    email: null,
    emails: [],
    phone: null,
    address: null,
    plz: null,
    companyName: null,
    uid: null,
  };
  let impressumUrl: string | null = null;
  let robotsBlockedAny = false;

  async function visit(url: string): Promise<void> {
    if (pagesUsed >= MAX_PAGES_PER_DOMAIN) return;
    if (visited.has(url)) return;
    if (budgetLeft() <= 0) return;
    const path = (() => {
      try {
        return new URL(url).pathname;
      } catch {
        return "/";
      }
    })();
    if (!robots.allowed(path)) {
      robotsBlockedAny = true;
      return;
    }
    visited.add(url);
    pagesUsed += 1;
    const res = await fetchFn(url, {
      timeoutMs: Math.min(PER_FETCH_TIMEOUT_MS, budgetLeft() || 1),
      retries: 0,
      userAgent: SCRAPER_USER_AGENT,
    });
    if (res.error || res.status !== 200 || !res.body) return;
    const parsed = parseImpressumPage(res.body);
    if (hasAnyContact(parsed)) {
      if (!impressumUrl) impressumUrl = res.finalUrl || url;
    }
    best = mergeParsed(best, parsed);
  }

  // 1. Home page — also the place we harvest footer-link candidates from.
  let footerLinks: string[] = [];
  {
    const homeUrl = siteUrl;
    try {
      const path = new URL(homeUrl).pathname || "/";
      if (!robots.allowed(path)) {
        robotsBlockedAny = true;
      } else {
        visited.add(homeUrl);
        pagesUsed += 1;
        const res = await fetchFn(homeUrl, {
          timeoutMs: Math.min(PER_FETCH_TIMEOUT_MS, budgetLeft() || 1),
          retries: 0,
          userAgent: SCRAPER_USER_AGENT,
        });
        if (!res.error && res.status === 200 && res.body) {
          const parsed = parseImpressumPage(res.body);
          if (hasAnyContact(parsed)) impressumUrl = null;
          best = mergeParsed(best, parsed);
          const $ = load(res.body);
          footerLinks = findImpressumLinks($, res.finalUrl || homeUrl);
        }
      }
    } catch (err) {
      log.warn(`home fetch threw for ${siteUrl}: ${(err as Error).message}`);
    }
  }

  // 2. Build candidate queue: footer links first, then conventional paths.
  const queue: string[] = [];
  const pushed = new Set(visited);
  for (const link of footerLinks) {
    if (!pushed.has(link)) {
      queue.push(link);
      pushed.add(link);
    }
  }
  for (const path of SCRAPER_PATHS) {
    const abs = absUrl(siteUrl, path);
    if (abs && !pushed.has(abs)) {
      queue.push(abs);
      pushed.add(abs);
    }
  }

  // 3. Visit candidates until budget or page cap is reached.
  for (const url of queue) {
    if (pagesUsed >= MAX_PAGES_PER_DOMAIN) break;
    if (budgetLeft() <= 0) break;
    await visit(url);
  }

  const coverage = buildCoverage(best.phone, best.email, best.address);
  const out: ScrapedContact = {
    impressumUrl,
    email: best.email,
    emails: best.emails,
    phone: best.phone,
    address: best.address,
    plz: best.plz,
    companyName: best.companyName,
    uid: best.uid,
    coverage,
    cacheHit: false,
    robotsBlocked: robotsBlockedAny,
  };

  // Persist even empty results — avoids re-crawling a domain that has
  // nothing useful within the TTL window.
  await writeCache(cacheDir, key, {
    createdAt: now.getTime(),
    url: siteUrl,
    data: stripCacheFields(out),
  });

  return out;
}

function hasAnyContact(p: ParsedPage): boolean {
  return Boolean(p.email || p.phone || p.address);
}

function stripCacheFields(
  s: ScrapedContact,
): Omit<ScrapedContact, "cacheHit"> {
  // cacheHit is derived at read-time; don't persist it.
  const {
    impressumUrl,
    email,
    emails,
    phone,
    address,
    plz,
    companyName,
    uid,
    coverage,
    robotsBlocked,
  } = s;
  return {
    impressumUrl,
    email,
    emails,
    phone,
    address,
    plz,
    companyName,
    uid,
    coverage,
    robotsBlocked,
  };
}
