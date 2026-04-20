import { promises as dns } from "node:dns";
import type { PlaceCandidate } from "../models/types.js";
import { slugify, stripUmlauts } from "../lib/normalize.js";
import { fetchUrl } from "../lib/http-fetch.js";

// Discriminated-union return so callers cannot accidentally probe a
// nameless candidate or run with the feature disabled. Previously
// `discoverViaDns` returned `null` on miss AND also threw on a null
// candidate name; the new contract surfaces every skip reason by name
// so observability can count them without log-parsing.
export type DnsProbeSkipReason =
  | "DNS_PROBE_DISABLED"
  | "NO_NAME"
  | "BRANCH_NAME"
  | "NO_CANDIDATES"
  | "NO_RESOLVABLE_DOMAIN";

export type DnsProbeResult =
  | { found: true; candidateUrl: string; validated: boolean }
  | { found: false; reason: DnsProbeSkipReason };

// DNS labels may not exceed 63 chars per RFC 1035. Filtering keeps us from
// generating guaranteed-invalid candidates that would only cost DNS round-trips.
const DNS_LABEL_MAX = 63;

// Branch-location names (franchise/chain branches) should not trigger DNS
// guesses — the guessed `{branch-name}.at` domain almost never belongs to
// the branch, and when it does it's typically a parking page. Match on
// the folded-lowercase name.
const BRANCH_NAME_TOKENS = ["filiale", "standort", "zweigstelle"] as const;

// Six deterministic URL guesses per name. Order matters: .at dominates Vienna
// SMEs, so it sits first. First-word-only variants (last entry) are a long-tail
// safety net for multi-word names where the full slug exceeds 63 chars.
export function generateCandidates(name: string): string[] {
  const s = slugify(name);
  if (!s) return [];
  const fw = s.split("-")[0] ?? s;
  const all = [
    `${s}.at`,
    `www.${s}.at`,
    `${s}.wien`,
    `${s}-wien.at`,
    `${s}.co.at`,
    `${fw}.at`,
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of all) {
    if (c.length > DNS_LABEL_MAX) continue;
    if (seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

export async function probeDomain(
  domain: string,
  timeoutMs = 3000,
): Promise<boolean> {
  try {
    const p = dns.resolve4(domain);
    const t = new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error("DNS_TIMEOUT")), timeoutMs),
    );
    await Promise.race([p, t]);
    return true;
  } catch {
    return false;
  }
}

// Guardrail against false-positive homepages. DNS + reachable HTTP alone is
// weak — parked pages, generic agency templates, typo-squatters all resolve.
// Accept-signal = at least two significant name-tokens OR a PLZ match OR a
// phone-digit match. Any single positive is enough; they're independent.
export function validatesCandidate(
  html: string,
  c: PlaceCandidate,
): boolean {
  const textLower = html.toLowerCase().slice(0, 20_000);
  // Use ASCII-folded, space-preserving tokens. normName() strips spaces and
  // collapses everything into one big string, which is useless for token-
  // matching. Here we fold umlauts + lowercase, then split on non-alphanum.
  const nameWords =
    stripUmlauts(c.name ?? "").toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const significant = nameWords.filter((w) => w.length >= 4);

  const nameHits = significant.filter((w) => textLower.includes(w)).length;
  if (nameHits >= 2) return true;

  if (c.plz && textLower.includes(c.plz)) return true;

  if (c.phone) {
    const digits = c.phone.replace(/\D/g, "");
    if (digits.length >= 7) {
      const last7 = digits.slice(-7);
      const siteDigits = textLower.replace(/\D/g, "");
      if (siteDigits.includes(last7)) return true;
    }
  }
  return false;
}

function isBranchName(name: string): boolean {
  const folded = stripUmlauts(name).toLowerCase();
  return BRANCH_NAME_TOKENS.some((t) => folded.includes(t));
}

export async function discoverViaDns(
  candidate: PlaceCandidate,
): Promise<DnsProbeResult> {
  // Env-gate: opt-in only. Costs real DNS round-trips and is off by default
  // outside production. Callers can rely on this short-circuit to ensure
  // no DNS queries leak during tests or CSV exports.
  if (process.env.DNS_PROBE_ENABLED !== "true") {
    return { found: false, reason: "DNS_PROBE_DISABLED" };
  }
  // Null/empty/whitespace-only name must not reach slugify(). Previously
  // `generateCandidates(null)` threw via `.replace` on null — this is the
  // crash the Phase 1 regression snapshot captured on R3_nameless_osm.
  const name = candidate.name;
  if (name == null || typeof name !== "string" || name.trim() === "") {
    return { found: false, reason: "NO_NAME" };
  }
  if (isBranchName(name)) {
    return { found: false, reason: "BRANCH_NAME" };
  }
  const domains = generateCandidates(name);
  if (domains.length === 0) {
    return { found: false, reason: "NO_CANDIDATES" };
  }
  for (const d of domains) {
    const resolved = await probeDomain(d);
    if (!resolved) continue;
    const url = `https://${d}`;
    const res = await fetchUrl(url, { timeoutMs: 15_000 });
    if (res.error || res.status >= 400) continue;
    if (validatesCandidate(res.body, candidate)) {
      return { found: true, candidateUrl: url, validated: true };
    }
  }
  return { found: false, reason: "NO_RESOLVABLE_DOMAIN" };
}
