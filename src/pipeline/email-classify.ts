// FIX 9 — email role classification. Replaces the old dead
// `genericEmails.includes(email)` check (which was always false in practice)
// with a real local-part classification against a curated role set.
//
// Return values carry three-valued meaning:
//   null → no email available (nothing to classify)
//   1    → local-part matches a generic/role mailbox (info@, office@, …)
//   0    → personal or otherwise non-role mailbox
//
// Matching is case-insensitive and Unicode-folded so büro@ and buero@ are
// equivalent. A numeric suffix on the local-part is still treated as
// generic — "info2@" and "team3@" classify as 1 the same way "info@" does.

const GENERIC_ROLES = new Set<string>([
  // International roles
  "info",
  "office",
  "kontakt",
  "contact",
  "hello",
  "hallo",
  "mail",
  "welcome",
  "service",
  "support",
  "sales",
  "admin",
  "team",
  // AT-specific roles
  "buero",
  "office1",
  "kanzlei",
  "praxis",
  "ordination",
  "rezeption",
  "empfang",
  "anfrage",
]);

// German/Austrian umlaut folding + ß. Preserves non-umlaut chars.
function unicodeFold(s: string): string {
  return s
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/ß/g, "ss");
}

// Returns 0 | 1 | null. Never throws — malformed inputs (empty string,
// missing @, or leading @) collapse to null so upstream callers can rely
// on the three-valued contract.
export function classifyEmailGeneric(
  email: string | null,
): 0 | 1 | null {
  if (email === null) return null;
  const at = email.indexOf("@");
  // at === 0 means the local-part is empty ("@example.at"); at === -1 is
  // a fragment with no @ at all. Both are "no classifiable mailbox".
  if (at <= 0) return null;
  const localPart = email.slice(0, at);
  const folded = unicodeFold(localPart);
  if (GENERIC_ROLES.has(folded)) return 1;
  // Digit-suffix variant: "info2" / "team3" → strip trailing digits and
  // re-check. "office1" is explicitly in the set so that path is redundant
  // for office1 but harmless for future role names.
  const stripped = folded.replace(/\d+$/, "");
  if (stripped !== folded && GENERIC_ROLES.has(stripped)) return 1;
  return 0;
}
