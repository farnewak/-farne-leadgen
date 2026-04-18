import { describe, it, expect } from "vitest";
import { classifyTier } from "../../src/pipeline/tier-classifier.js";

describe("classifyTier", () => {
  it("returns A when site reachable and no error", () => {
    expect(
      classifyTier({
        hasDiscoveredUrl: true,
        fetchError: null,
        socialLinksCount: 0,
        directoryHitsCount: 0,
      }),
    ).toBe("A");
  });

  it("returns C for CERT_EXPIRED with a discovered URL", () => {
    expect(
      classifyTier({
        hasDiscoveredUrl: true,
        fetchError: "CERT_EXPIRED",
        socialLinksCount: 0,
        directoryHitsCount: 0,
      }),
    ).toBe("C");
  });

  it("returns C for HTTP_5XX with a discovered URL", () => {
    expect(
      classifyTier({
        hasDiscoveredUrl: true,
        fetchError: "HTTP_5XX",
        socialLinksCount: 0,
        directoryHitsCount: 0,
      }),
    ).toBe("C");
  });

  it("returns C for DNS_FAIL with a discovered URL", () => {
    expect(
      classifyTier({
        hasDiscoveredUrl: true,
        fetchError: "DNS_FAIL",
        socialLinksCount: 0,
        directoryHitsCount: 0,
      }),
    ).toBe("C");
  });

  it("falls through to B1 on TIMEOUT (not a Tier-C error)", () => {
    expect(
      classifyTier({
        hasDiscoveredUrl: true,
        fetchError: "TIMEOUT",
        socialLinksCount: 1,
        directoryHitsCount: 0,
      }),
    ).toBe("B1");
  });

  it("returns B1 when no URL but socials exist", () => {
    expect(
      classifyTier({
        hasDiscoveredUrl: false,
        fetchError: null,
        socialLinksCount: 2,
        directoryHitsCount: 1,
      }),
    ).toBe("B1");
  });

  it("returns B2 when no URL/socials but directories hit", () => {
    expect(
      classifyTier({
        hasDiscoveredUrl: false,
        fetchError: null,
        socialLinksCount: 0,
        directoryHitsCount: 3,
      }),
    ).toBe("B2");
  });

  it("returns B3 when no signal at all", () => {
    expect(
      classifyTier({
        hasDiscoveredUrl: false,
        fetchError: null,
        socialLinksCount: 0,
        directoryHitsCount: 0,
      }),
    ).toBe("B3");
  });

  it("returns B3 when only fetch error (no URL claimed)", () => {
    expect(
      classifyTier({
        hasDiscoveredUrl: false,
        fetchError: "DNS_FAIL",
        socialLinksCount: 0,
        directoryHitsCount: 0,
      }),
    ).toBe("B3");
  });
});
