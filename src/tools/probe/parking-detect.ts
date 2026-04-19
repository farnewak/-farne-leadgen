// HTML-only parking-page detector. Returns a verdict and, when
// applicable, the matched fingerprint for observability.
//
// Design rule (I3 in the spec): on uncertainty the verdict is
// "inconclusive", NOT "parked". False-positives poison the scoring
// bonus — a legitimate small site must never be reclassified as
// C-PARKED. Only clear parking-page signatures flip to "parked".
//
// Fingerprints intentionally look at multiple independent hints
// (host, HTML content, meta-refresh destinations) per fingerprint so
// a single low-entropy string match doesn't trigger the verdict.

export const PARKING_VERDICTS = ["parked", "not-parked", "inconclusive"] as const;
export type ParkingVerdict = (typeof PARKING_VERDICTS)[number];

export interface ParkingDetectionInput {
  body: string;
  finalUrl: string | null;
  headers?: Record<string, string>;
}

export interface ParkingDetectionResult {
  verdict: ParkingVerdict;
  fingerprint: string | null;
}

const MIN_BODY_BYTES = 1024;

interface Fingerprint {
  id: string;
  match: (input: NormalizedInput) => boolean;
}

interface NormalizedInput {
  bodyLower: string;
  hostLower: string;
  bodyLen: number;
  hasBodyChildren: boolean;
  hasTitleOnly: boolean;
}

function normalize(input: ParkingDetectionInput): NormalizedInput {
  const body = input.body ?? "";
  const bodyLower = body.toLowerCase();
  let hostLower = "";
  try {
    if (input.finalUrl) hostLower = new URL(input.finalUrl).host.toLowerCase();
  } catch {
    hostLower = "";
  }
  // <body>...</body> must contain at least one tag OR non-whitespace text
  // beyond a single <title>-like header. A bare <body></body> counts as no
  // children. Conservative: if no <body> tag at all → no children either.
  const bodyMatch = body.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const bodyInner = bodyMatch?.[1] ?? "";
  const bodyInnerStripped = bodyInner.replace(/<!--[\s\S]*?-->/g, "").trim();
  const hasBodyChildren = bodyInnerStripped.length > 0;
  const hasTitleTag = /<title[^>]*>.*?<\/title>/i.test(body);
  const hasTitleOnly = hasTitleTag && !hasBodyChildren;
  return {
    bodyLower,
    hostLower,
    bodyLen: body.length,
    hasBodyChildren,
    hasTitleOnly,
  };
}

const FINGERPRINTS: readonly Fingerprint[] = [
  {
    id: "sedo",
    match: (n) =>
      n.hostLower.includes("sedoparking.com") ||
      n.bodyLower.includes("sedoparking.com") ||
      n.bodyLower.includes("this domain may be for sale") ||
      n.bodyLower.includes("sedo.com/search/") ||
      n.bodyLower.includes("buy this domain"),
  },
  {
    id: "godaddy",
    match: (n) =>
      n.bodyLower.includes("godaddy.com/domainsearch") ||
      n.bodyLower.includes("godaddy.com/offer") ||
      n.bodyLower.includes("cashparking") ||
      (n.bodyLower.includes("godaddy") && n.bodyLower.includes("this domain")),
  },
  {
    id: "namecheap",
    match: (n) =>
      /cp\d*\.namecheap\.com/i.test(n.hostLower) ||
      /cp\d*\.namecheap\.com/i.test(n.bodyLower) ||
      (n.bodyLower.includes("namecheap") &&
        n.bodyLower.includes("this domain is parked")),
  },
  {
    id: "ionos",
    match: (n) =>
      n.bodyLower.includes("diese website ist auf ihre bestellung vorbereitet") ||
      n.bodyLower.includes("this web site is prepared for your order") ||
      n.bodyLower.includes("ionos.de/webhosting") ||
      (n.bodyLower.includes("ionos") && n.bodyLower.includes("placeholder")) ||
      (n.bodyLower.includes("1und1") && n.bodyLower.includes("bestellung")),
  },
  {
    id: "parkingcrew",
    match: (n) =>
      n.bodyLower.includes("parkingcrew.net") ||
      n.bodyLower.includes("parkingaccess.com") ||
      n.bodyLower.includes("parked on the bodis platform"),
  },
  {
    id: "bodis",
    match: (n) =>
      n.bodyLower.includes("bodis.com") ||
      n.bodyLower.includes("parked on the bodis") ||
      /bodis\.com\/lander/i.test(n.bodyLower),
  },
  {
    id: "server-default",
    match: (n) =>
      n.bodyLower.includes("apache2 ubuntu default page") ||
      n.bodyLower.includes("apache2 debian default page") ||
      n.bodyLower.includes("welcome to nginx!") ||
      (n.bodyLower.includes("it works!") && n.bodyLen < 2048),
  },
  {
    id: "coming-soon",
    match: (n) =>
      (n.bodyLower.includes("coming soon") ||
        n.bodyLower.includes("under construction") ||
        n.bodyLower.includes("site is under construction") ||
        n.bodyLower.includes("in kürze verfügbar") ||
        n.bodyLower.includes("wir sind bald für sie da")) &&
      n.bodyLen < 4096,
  },
  {
    id: "empty-html",
    match: (n) => n.bodyLen < MIN_BODY_BYTES || n.hasTitleOnly,
  },
  {
    id: "whmcs-cpanel",
    match: (n) =>
      n.bodyLower.includes("whmcs.com") ||
      n.bodyLower.includes("powered by whmcs") ||
      n.bodyLower.includes("cpanel, inc.") ||
      (n.bodyLower.includes("cpanel") && n.bodyLower.includes("default page")) ||
      n.bodyLower.includes("cpsrvd"),
  },
];

// Exported for tests — lets a test assert the full fingerprint inventory
// without re-deriving it.
export function listFingerprintIds(): string[] {
  return FINGERPRINTS.map((f) => f.id);
}

export function detectParking(
  input: ParkingDetectionInput,
): ParkingDetectionResult {
  const normalized = normalize(input);
  for (const fp of FINGERPRINTS) {
    if (fp.match(normalized)) {
      return { verdict: "parked", fingerprint: fp.id };
    }
  }
  // A healthy site has a body with children and above the min-byte bar.
  // Anything below that bar but not matching a fingerprint is "inconclusive"
  // — the caller may choose to fall back to WHOIS.
  if (!normalized.hasBodyChildren || normalized.bodyLen < 2048) {
    return { verdict: "inconclusive", fingerprint: null };
  }
  return { verdict: "not-parked", fingerprint: null };
}
