import { promises as dns } from "node:dns";
import type { PlaceCandidate } from "../models/types.js";
import { slugify, stripUmlauts } from "../lib/normalize.js";
import { fetchUrl } from "../lib/http-fetch.js";

export interface DnsProbeResult {
  candidateUrl: string;
  resolved: boolean;
  validated: boolean;
}

// DNS labels may not exceed 63 chars per RFC 1035. Filtering keeps us from
// generating guaranteed-invalid candidates that would only cost DNS round-trips.
const DNS_LABEL_MAX = 63;

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
    stripUmlauts(c.name).toLowerCase().match(/[a-z0-9]+/g) ?? [];
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

export async function discoverViaDns(
  candidate: PlaceCandidate,
): Promise<DnsProbeResult | null> {
  const domains = generateCandidates(candidate.name);
  for (const d of domains) {
    const resolved = await probeDomain(d);
    if (!resolved) continue;
    const url = `https://${d}`;
    const res = await fetchUrl(url, { timeoutMs: 15_000 });
    if (res.error || res.status >= 400) continue;
    if (validatesCandidate(res.body, candidate)) {
      return { candidateUrl: url, resolved: true, validated: true };
    }
  }
  return null;
}
