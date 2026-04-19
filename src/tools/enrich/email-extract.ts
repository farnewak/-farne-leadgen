// Email harvesting with anti-obfuscation.
//
// Design rules (spec §C I3):
//   - Standard regex on deobfuscated text.
//   - Deobfuscate common anti-spam patterns: " [at] ", "(at)", "&#64;",
//     " (ät) ", "[æt]", " [dot] ", "(dot)".
//   - Also pick up mailto: hrefs in anchors.
//   - Noise filter is NARROW. Generic-business addresses
//     (info@, office@, kontakt@, …) are legitimate — these are often the
//     only published contact and MUST survive. Only strip obvious
//     placeholders (example.com, noreply@, webmaster@hoster, …).
//   - Priority: personalised (max.mustermann@) before role-based (info@).
//     All candidates are returned; the first element is the preferred one.
//
// Anti-malware note: this module extracts contact emails from publicly
// published Austrian Impressum pages for B2B cold-outreach lead generation
// — the same data that §5 ECG-Impressumspflicht requires to be displayed.

const DOMAIN_BLOCKLIST: readonly string[] = [
  "example.com",
  "example.org",
  "example.net",
  "domain.tld",
  "test.com",
  "localhost",
];

// Local-parts whose recipient is guaranteed to be a technical / platform
// mailbox rather than a business contact.
const LOCAL_BLOCKLIST: readonly string[] = [
  "noreply",
  "no-reply",
  "donotreply",
  "do-not-reply",
  "webmaster",
  "postmaster",
  "abuse",
  "hostmaster",
  "wp",
  "root",
];

// Role-based local parts: these STAY in results, but sort after
// personalised addresses when prioritising.
const ROLE_LOCAL_PARTS: readonly string[] = [
  "info",
  "office",
  "kontakt",
  "contact",
  "hello",
  "hallo",
  "mail",
  "service",
  "support",
  "sales",
  "vertrieb",
  "team",
  "verwaltung",
  "sekretariat",
  "anfrage",
  "anfragen",
  "willkommen",
  "buero",
  "büro",
];

const EMAIL_REGEX = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g;

const HTML_ENTITY_AT = /&#64;|&#x40;/gi;
const HTML_ENTITY_DOT = /&#46;|&#x2e;/gi;

// (at) / [at] / {at} variants, case-insensitive, with optional whitespace.
// Only collapses when surrounded by word-characters on both sides so free
// English text containing "(at)" as a preposition isn't touched.
const AT_OBFUSCATION = /(\w)\s*[\[\(\{]\s*(?:at|ät|æt)\s*[\]\)\}]\s*(\w)/gi;
const DOT_OBFUSCATION = /(\w)\s*[\[\(\{]\s*(?:dot|punkt)\s*[\]\)\}]\s*(\w)/gi;

// " AT " / " ÄT " spelled-out versions. More fragile — requires the
// surrounding whitespace + at least one dot-separated label afterwards.
const SPACED_AT = /(\w+)\s+(?:at|ät)\s+(\w[\w.-]*\.[A-Za-z]{2,})/gi;

export function deobfuscate(raw: string): string {
  let s = raw
    .replace(HTML_ENTITY_AT, "@")
    .replace(HTML_ENTITY_DOT, ".");
  // Repeated passes let deobfuscation chain: a string like
  // "foo [at] bar [dot] com" becomes "foo@bar.com" in two passes.
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s
      .replace(AT_OBFUSCATION, "$1@$2")
      .replace(DOT_OBFUSCATION, "$1.$2")
      .replace(SPACED_AT, "$1@$2");
    if (s === before) break;
  }
  return s;
}

// Accepts only the four explicit noise categories from spec §C I3.
// Role-based addresses (info@, office@, …) are NOT noise.
export function isNoiseEmail(email: string): boolean {
  const at = email.indexOf("@");
  if (at <= 0 || at === email.length - 1) return true;
  const local = email.slice(0, at).toLowerCase();
  const domain = email.slice(at + 1).toLowerCase();

  for (const bad of DOMAIN_BLOCKLIST) {
    if (domain === bad || domain.endsWith(`.${bad}`)) return true;
  }

  // admin@wordpress.org is a special-case noise pattern (CMS default user)
  if (local === "admin" && domain === "wordpress.org") return true;

  for (const bad of LOCAL_BLOCKLIST) {
    if (local === bad) return true;
  }

  return false;
}

// Cheap "is this a person's name?" heuristic. Works on the local part:
//   max.mustermann  → personal
//   j.doe           → personal (short initial + surname)
//   info            → role
//   info42          → role (digit suffix)
// We deliberately don't try to distinguish further — any non-role
// candidate that contains a separator is treated as personal.
export function isRoleEmail(email: string): boolean {
  const at = email.indexOf("@");
  if (at <= 0) return false;
  const local = email.slice(0, at).toLowerCase();
  for (const role of ROLE_LOCAL_PARTS) {
    if (local === role) return true;
    if (local.startsWith(role)) {
      const next = local.charAt(role.length);
      if (next === "." || next === "-" || next === "_") return true;
      if (next >= "0" && next <= "9") return true;
    }
  }
  return false;
}

// Orders candidates: personalised addresses before role-based ones.
// Stable relative to input order within each bucket — first-seen wins
// when everything else is equal (e.g. page-order preference).
export function prioritizeEmails(emails: string[]): string[] {
  const personal: string[] = [];
  const role: string[] = [];
  for (const e of emails) {
    if (isRoleEmail(e)) role.push(e);
    else personal.push(e);
  }
  return [...personal, ...role];
}

// Full extraction path: deobfuscate → regex-scan → dedupe (case-insensitive
// on local + domain) → drop noise → prioritise. Callers can separately pull
// mailto: hrefs via `extractMailtoHrefs` and merge before calling this.
export function extractEmails(rawText: string): string[] {
  const clean = deobfuscate(rawText);
  const seen = new Set<string>();
  const out: string[] = [];
  const matches = clean.match(EMAIL_REGEX) ?? [];
  for (const raw of matches) {
    const email = raw.toLowerCase();
    if (seen.has(email)) continue;
    if (isNoiseEmail(email)) continue;
    seen.add(email);
    out.push(email);
  }
  return prioritizeEmails(out);
}

// Pulls emails out of mailto: hrefs. Separate from extractEmails because
// the href may legitimately contain query parameters (?subject=…) that
// must be stripped before validation.
export function extractMailtoEmails(mailtoHrefs: readonly string[]): string[] {
  const out: string[] = [];
  for (const href of mailtoHrefs) {
    const lower = href.toLowerCase();
    if (!lower.startsWith("mailto:")) continue;
    const rest = href.slice(7);
    const qIdx = rest.indexOf("?");
    const address = (qIdx >= 0 ? rest.slice(0, qIdx) : rest).trim();
    if (address.length > 0) out.push(address.toLowerCase());
  }
  return out;
}
