import { describe, it, expect } from "vitest";
import { classifyEmailGeneric } from "../../src/pipeline/email-classify.js";

// Test matrix — each row is {input, expected}. Keeps the cases list
// terse so adding a new role or edge case is a one-line change.
const CASES: Array<{
  input: string | null;
  expected: 0 | 1 | null;
  label: string;
}> = [
  { input: null, expected: null, label: "no email → null" },
  { input: "info@example.at", expected: 1, label: "generic info@" },
  { input: "INFO@example.at", expected: 1, label: "mixed case → folded" },
  { input: "büro@wien.at", expected: 1, label: "AT umlaut büro@" },
  { input: "buero@wien.at", expected: 1, label: "ASCII fold buero@" },
  { input: "office1@wien.at", expected: 1, label: "explicit office1@" },
  { input: "kanzlei@wien.at", expected: 1, label: "AT role kanzlei@" },
  { input: "ordination@wien.at", expected: 1, label: "AT role ordination@" },
  {
    input: "firstname.lastname@example.at",
    expected: 0,
    label: "personal firstname.lastname@",
  },
  { input: "ada@example.at", expected: 0, label: "personal single-firstname" },
  {
    input: "info2@example.at",
    expected: 1,
    label: "numeric suffix info2@ still generic",
  },
  {
    input: "team3@example.at",
    expected: 1,
    label: "numeric suffix team3@ still generic",
  },
  // Domain-less edge cases must return null WITHOUT throwing.
  { input: "notanemail", expected: null, label: "domain-less fragment → null" },
  { input: "", expected: null, label: "empty string → null" },
  { input: "@example.at", expected: null, label: "empty local-part → null" },
  // Extra umlaut roles to cover the full fold table.
  { input: "RezepTion@wien.at", expected: 1, label: "mixed-case AT role" },
  { input: "empfang@wien.at", expected: 1, label: "AT role empfang@" },
  { input: "anfrage@wien.at", expected: 1, label: "AT role anfrage@" },
];

describe("classifyEmailGeneric", () => {
  for (const c of CASES) {
    it(c.label, () => {
      expect(classifyEmailGeneric(c.input)).toBe(c.expected);
    });
  }
});
