// Prefixes for role/shared mailboxes that are safe for B2B outreach per
// DSGVO (no identifiable natural person). Used downstream to decide whether
// an email found during audit may be persisted and used for outreach.
export const GENERIC_BUSINESS_EMAIL_PREFIXES: readonly string[] = [
  "office",
  "info",
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
];

// Matches if the local-part IS the prefix, or starts with the prefix
// followed by ".", "-", "_" or a digit (e.g. "office.wien", "info42").
// Personalised addresses like "max.mustermann" are rejected.
export function isGenericBusinessEmail(email: string): boolean {
  const at = email.indexOf("@");
  if (at <= 0) return false;
  const local = email.slice(0, at).toLowerCase().trim();
  if (local.length === 0) return false;

  for (const prefix of GENERIC_BUSINESS_EMAIL_PREFIXES) {
    if (local === prefix) return true;
    if (local.length <= prefix.length) continue;
    if (!local.startsWith(prefix)) continue;
    const next = local.charAt(prefix.length);
    if (next === "." || next === "-" || next === "_") return true;
    if (next >= "0" && next <= "9") return true;
  }
  return false;
}
