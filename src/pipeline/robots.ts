import { fetchUrl } from "../lib/http-fetch.js";
import { makeLogger } from "../lib/logger.js";

const log = makeLogger("robots");

export interface RobotsRules {
  // Decides if a path on the associated origin may be fetched by this crawler.
  // Implementation uses longest-prefix match over the origin's User-agent: *
  // Allow/Disallow block. Always returns true on fail-open (network error,
  // malformed robots.txt). We deliberately don't support per-UA rules — our
  // crawler isn't special enough to have its own allowlist in anyone's file.
  allowed: (path: string) => boolean;
  // Minimum delay between successive requests to this origin, in ms.
  // `0` when robots.txt doesn't specify a Crawl-delay. Honoured in addition
  // to AUDIT_MIN_DELAY_PER_HOST_MS — the orchestrator uses max(env, robots).
  crawlDelayMs: number;
}

const ALLOW_ALL: RobotsRules = {
  allowed: () => true,
  crawlDelayMs: 0,
};

// Cache by canonical origin (protocol + host [+ :port]). NOT by host alone:
// RFC 9309 treats http://x.at/robots.txt and https://x.at/robots.txt as
// independent documents, so we do too.
const cache = new Map<string, Promise<RobotsRules>>();

export function resetRobotsCache(): void {
  cache.clear();
}

function canonicalOrigin(originInput: string): string {
  const u = new URL(originInput);
  // URL.origin already collapses default ports (443/80) — exactly what we want.
  return u.origin;
}

interface ParsedRule {
  allow: boolean;
  path: string;
}

// Collect rules from the User-agent: * block only. Per spec, group semantics:
// each "User-agent:" line starts a new group; rules apply to all UAs listed
// in the immediately-preceding run of UA lines. We flatten to a single bucket.
function parseRobotsTxt(body: string): { rules: ParsedRule[]; crawlDelayMs: number } {
  const rules: ParsedRule[] = [];
  let crawlDelayMs = 0;
  let inStarBlock = false;
  // `pendingUaBlock` handles "User-agent: Googlebot\nUser-agent: *" —
  // successive UA lines without rules between them form one group.
  let pendingUaBlock = false;

  for (const rawLine of body.split(/\r?\n/)) {
    const noComment = rawLine.split("#")[0] ?? "";
    const line = noComment.trim();
    if (!line) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const field = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();

    if (field === "user-agent") {
      if (!pendingUaBlock) {
        // New group begins — reset the star-block flag until we see all UA lines.
        inStarBlock = false;
      }
      pendingUaBlock = true;
      if (value === "*") inStarBlock = true;
      continue;
    }

    // First non-UA directive closes the pending UA block.
    pendingUaBlock = false;
    if (!inStarBlock) continue;

    if (field === "disallow") {
      // Empty Disallow means "allow everything" per spec — emit an Allow:/
      // so longest-prefix-match treats it as a permissive root rule.
      if (value === "") {
        rules.push({ allow: true, path: "/" });
      } else {
        rules.push({ allow: false, path: value });
      }
    } else if (field === "allow") {
      rules.push({ allow: true, path: value });
    } else if (field === "crawl-delay") {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds > 0) {
        crawlDelayMs = Math.round(seconds * 1000);
      }
    }
  }

  return { rules, crawlDelayMs };
}

// Longest prefix wins; Allow ties beat Disallow ties. RFC 9309 §2.2.2.
function buildMatcher(rules: ParsedRule[]): (path: string) => boolean {
  if (rules.length === 0) return () => true;
  return (path: string) => {
    let best: ParsedRule | null = null;
    for (const r of rules) {
      if (!path.startsWith(r.path)) continue;
      if (!best) {
        best = r;
        continue;
      }
      if (r.path.length > best.path.length) {
        best = r;
      } else if (r.path.length === best.path.length && r.allow && !best.allow) {
        best = r;
      }
    }
    return best ? best.allow : true;
  };
}

async function fetchRobots(origin: string): Promise<RobotsRules> {
  const url = `${origin}/robots.txt`;
  const res = await fetchUrl(url, {
    timeoutMs: 5_000,
    retries: 0,
    userAgent: "farne-leadgen/0.1 (+farne-solutions.com)",
  });
  if (res.error || res.status !== 200 || !res.body) {
    return ALLOW_ALL;
  }
  try {
    const { rules, crawlDelayMs } = parseRobotsTxt(res.body);
    return { allowed: buildMatcher(rules), crawlDelayMs };
  } catch (err) {
    log.warn(`robots parse failed for ${url}`, (err as Error).message);
    return ALLOW_ALL;
  }
}

// Cache-by-origin; identical second call returns the same promise → ensures
// only one network request per origin even under concurrent audits.
export async function getRobotsRules(origin: string): Promise<RobotsRules> {
  let canonical: string;
  try {
    canonical = canonicalOrigin(origin);
  } catch {
    return ALLOW_ALL;
  }
  const hit = cache.get(canonical);
  if (hit) return hit;
  const p = fetchRobots(canonical);
  cache.set(canonical, p);
  return p;
}
