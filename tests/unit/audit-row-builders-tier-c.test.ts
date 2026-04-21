import { describe, it, expect } from "vitest";
import {
  buildEmptyTierRow,
  type DiscoveryOutcome,
} from "../../src/pipeline/audit-row-builders.js";
import type { PlaceCandidate } from "../../src/models/types.js";

function makeCandidate(): PlaceCandidate {
  return {
    placeId: "osm:node:1",
    name: "Test GmbH",
    address: "Teststraße 1, 1010 Wien",
    plz: "1010",
    district: "1010",
    types: [],
    primaryType: null,
    website: "https://example.at",
    phone: null,
    lat: 48.2,
    lng: 16.37,
  };
}

function makeDiscovery(fetchError: "DNS_FAIL" | null): DiscoveryOutcome {
  return {
    discoveredUrl: "https://example.at",
    discoveryMethod: "osm-tag",
    fetchError,
    homeBody: null,
    homeHeaders: {},
    finalUrl: null,
  };
}

describe("buildEmptyTierRow — tier='C' intent_tier normalisation", () => {
  const now = new Date("2026-04-21T12:00:00.000Z");

  it("forces intent_tier from 'DEAD' to 'NONE' on a tier='C' row with DNS_FAIL", () => {
    const row = buildEmptyTierRow(
      makeCandidate(),
      "C",
      makeDiscovery("DNS_FAIL"),
      now,
      "DEAD",
    );
    expect(row.tier).toBe("C");
    expect(row.intentTier).toBe("NONE");
    expect(row.fetchError).toBe("DNS_FAIL");
  });

  it("preserves intent_tier='PARKED' on a tier='C' row (parking-detect override must survive)", () => {
    const row = buildEmptyTierRow(
      makeCandidate(),
      "C",
      makeDiscovery(null),
      now,
      "PARKED",
    );
    expect(row.tier).toBe("C");
    expect(row.intentTier).toBe("PARKED");
  });

  it("leaves a tier='B3' row with intent_tier='DEAD_WEBSITE' untouched", () => {
    const row = buildEmptyTierRow(
      makeCandidate(),
      "B3",
      makeDiscovery(null),
      now,
      "DEAD_WEBSITE",
    );
    expect(row.tier).toBe("B3");
    expect(row.intentTier).toBe("DEAD_WEBSITE");
  });
});
