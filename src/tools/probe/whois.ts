import { Socket } from "node:net";

// Minimal WHOIS client used as an OPTIONAL fallback by the parking
// detector. Contract (per I2 in the spec):
//   - timeout 3s (configurable)
//   - fail-open: on any error/timeout, return { registered: null }
//   - the caller MUST NOT treat null as "registered=true" and MUST
//     default to C-DEAD rather than C-PARKED on uncertainty (I3).
//
// We talk WHOIS directly over TCP/43 — no third-party dep needed.
// TLD→server map covers the Austrian context (.at, .com, .net, .org,
// .de, .eu). Unknown TLDs fall back to whois.iana.org, which replies
// with a referral the registry WHOIS would follow; for a registered/
// not-registered check at 3s budget we accept the shallow answer.

export interface WhoisResult {
  registered: boolean | null;
  raw: string | null;
}

const WHOIS_SERVERS: Readonly<Record<string, string>> = {
  at: "whois.nic.at",
  com: "whois.verisign-grs.com",
  net: "whois.verisign-grs.com",
  org: "whois.publicinterestregistry.org",
  de: "whois.denic.de",
  eu: "whois.eu",
  io: "whois.nic.io",
};

// NOT-registered markers — lowercase, free-text substring match. The
// registrar's "no match" / "no entries" language is load-bearing: we
// treat these as a positive assertion of "available/unregistered".
// Adding a new TLD usually means extending this list after eyeballing
// one negative-case response.
const NOT_FOUND_PATTERNS: readonly string[] = [
  "no match",
  "not found",
  "no entries found",
  "no data found",
  "status: free",
  "status: available",
  "% nothing found",
  "domain not found",
  "is available for registration",
];

// Registered-indicator markers. We look for any of these AFTER ruling
// out not-found. A response that contains neither is "null" — the
// caller knows to err on the side of DEAD, not PARKED.
const REGISTERED_PATTERNS: readonly string[] = [
  "registrar:",
  "creation date",
  "created:",
  "changed:",
  "registered:",
  "domain:",
  "registrant",
  "updated date",
];

export function serverFor(domain: string): string {
  const tld = domain.split(".").pop()?.toLowerCase() ?? "";
  return WHOIS_SERVERS[tld] ?? "whois.iana.org";
}

// Exported so tests can feed sample WHOIS responses without opening
// real sockets. Pure function, no side effects.
export function parseWhoisResponse(raw: string): boolean | null {
  if (raw.length === 0) return null;
  const lower = raw.toLowerCase();
  for (const p of NOT_FOUND_PATTERNS) {
    if (lower.includes(p)) return false;
  }
  for (const p of REGISTERED_PATTERNS) {
    if (lower.includes(p)) return true;
  }
  return null;
}

export interface WhoisOptions {
  timeoutMs?: number;
  server?: string;
}

export async function checkDomainRegistered(
  domain: string,
  opts: WhoisOptions = {},
): Promise<WhoisResult> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const server = opts.server ?? serverFor(domain);
  return new Promise<WhoisResult>((resolve) => {
    const socket = new Socket();
    let data = "";
    let settled = false;
    const finish = (result: WhoisResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish({ registered: null, raw: null });
    }, timeoutMs);
    socket.setTimeout(timeoutMs);
    socket.on("data", (chunk) => {
      data += chunk.toString("utf-8");
    });
    socket.on("end", () => {
      finish({ registered: parseWhoisResponse(data), raw: data });
    });
    socket.on("error", () => {
      finish({ registered: null, raw: null });
    });
    socket.on("timeout", () => {
      finish({ registered: null, raw: null });
    });
    socket.connect(43, server, () => {
      socket.write(`${domain}\r\n`);
    });
  });
}
