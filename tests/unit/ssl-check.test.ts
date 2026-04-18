import { describe, it, expect, vi, afterEach } from "vitest";
import { checkTransport } from "../../src/pipeline/ssl-check.js";

// These tests are pure smoke / contract checks — the heavy lifting is the
// tls.connect call which we cannot mock cleanly without injecting a factory.
// We verify the shape of the result and that missing hosts surface as
// non-throwing errors.
describe("checkTransport", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns SslCheckResult shape for an unresolvable host", async () => {
    const r = await checkTransport("this-host-should-never-resolve.invalid");
    expect(r).toHaveProperty("sslValid");
    expect(r).toHaveProperty("sslExpiresAt");
    expect(r).toHaveProperty("httpToHttpsRedirect");
    expect(r).toHaveProperty("fetchError");
    expect(r.sslValid).toBe(false);
    // DNS_FAIL or TIMEOUT or SSL_HANDSHAKE are all acceptable for an invalid
    // TLD — exact code is OS-dependent. Just assert an error was returned.
    expect(r.fetchError).not.toBeNull();
  }, 15_000);

  it("never throws on malformed hostname", async () => {
    const r = await checkTransport("not.a.real.host.example.invalid.tld");
    expect(r.fetchError).not.toBeNull();
    expect(r.sslValid).toBe(false);
  }, 15_000);
});
