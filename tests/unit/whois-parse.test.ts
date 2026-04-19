import { describe, it, expect } from "vitest";
import {
  parseWhoisResponse,
  serverFor,
} from "../../src/tools/probe/whois.js";

// Sample WHOIS responses — abbreviated but keep the discriminating tokens the
// parser looks for. Reflects real formats from each registry.

const AT_REGISTERED = `% Copyright (c)2026 by NIC.AT (1)
domain:         farne-solutions.com
registrant:     HT-12345
tech-c:         HT-12345
changed:        2020-06-12T08:22:10Z
source:         AT-DOM
`;

const AT_FREE = `% Copyright (c)2026 by NIC.AT (1)
% nothing found
`;

const COM_REGISTERED = `Domain Name: EXAMPLE.COM
Registrar: Example Registrar LLC
Creation Date: 1995-08-14T04:00:00Z
Updated Date: 2025-08-13T07:00:00Z
Registrant Organization: Example Org
`;

const COM_NOT_FOUND = `No match for "NONEXISTENT-DOMAIN-12345.COM".
>>> Last update of whois database: 2026-04-19T00:00:00Z <<<
`;

const DE_AVAILABLE = `% Error: 55000000002 Domain status: free
`;

const EMPTY = "";

describe("parseWhoisResponse", () => {
  it("detects .at registered via 'changed:'/'registrant:' tokens", () => {
    expect(parseWhoisResponse(AT_REGISTERED)).toBe(true);
  });

  it("detects .at free via '% nothing found'", () => {
    expect(parseWhoisResponse(AT_FREE)).toBe(false);
  });

  it("detects .com registered via 'Registrar:'/'Creation Date'", () => {
    expect(parseWhoisResponse(COM_REGISTERED)).toBe(true);
  });

  it("detects .com not-found via 'No match'", () => {
    expect(parseWhoisResponse(COM_NOT_FOUND)).toBe(false);
  });

  it("detects .de free via 'Status: free'", () => {
    expect(parseWhoisResponse(DE_AVAILABLE)).toBe(false);
  });

  it("returns null on empty response", () => {
    expect(parseWhoisResponse(EMPTY)).toBeNull();
  });

  it("returns null on ambiguous response (no marker)", () => {
    const raw = "Some unrelated text that contains none of the markers.";
    expect(parseWhoisResponse(raw)).toBeNull();
  });

  it("not-found patterns win over registered patterns", () => {
    // Edge case: registry response that includes a Registrar: comment line
    // but is ultimately a "no match" response. not-found must take precedence.
    const mixed = `Registrar: whois.verisign-grs.com
No match for "FOO.COM".
`;
    expect(parseWhoisResponse(mixed)).toBe(false);
  });
});

describe("serverFor", () => {
  it.each([
    ["example.at", "whois.nic.at"],
    ["example.com", "whois.verisign-grs.com"],
    ["example.net", "whois.verisign-grs.com"],
    ["example.de", "whois.denic.de"],
    ["example.eu", "whois.eu"],
    ["example.io", "whois.nic.io"],
  ])("maps %s to %s", (domain, expected) => {
    expect(serverFor(domain)).toBe(expected);
  });

  it("falls back to whois.iana.org for unknown TLDs", () => {
    expect(serverFor("example.xyz")).toBe("whois.iana.org");
  });
});
