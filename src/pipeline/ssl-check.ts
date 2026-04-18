import tls from "node:tls";
import type { FetchError } from "../models/audit.js";
import { fetchUrl } from "../lib/http-fetch.js";

export interface SslCheckResult {
  sslValid: boolean | null;
  sslExpiresAt: Date | null;
  httpToHttpsRedirect: boolean | null;
  fetchError: FetchError | null;
}

// 10s total budget is enough for a TCP handshake + TLS + cert parse on any
// reachable host. Anything slower indicates a misconfigured or half-broken
// server — we surface that as TIMEOUT rather than waiting minutes.
const TLS_TIMEOUT_MS = 10_000;
const TLS_PORT = 443;

interface TlsProbeResult {
  valid: boolean;
  expiresAt: Date | null;
  error: FetchError | null;
}

// Uses tls.connect() with `rejectUnauthorized: true` so the OS trust store
// decides validity. Self-signed or expired certs will emit 'error' with a
// node-style code that maps to CERT_INVALID / CERT_EXPIRED.
function probeTls(hostname: string): Promise<TlsProbeResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: TlsProbeResult): void => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // ignore
      }
      resolve(r);
    };

    const socket = tls.connect(
      {
        host: hostname,
        port: TLS_PORT,
        servername: hostname,
        rejectUnauthorized: true,
        timeout: TLS_TIMEOUT_MS,
      },
      () => {
        const cert = socket.getPeerCertificate();
        // Empty cert object → handshake succeeded but peer sent nothing
        // usable; treat as invalid rather than throwing a TypeError later.
        if (!cert || Object.keys(cert).length === 0) {
          finish({ valid: false, expiresAt: null, error: "CERT_INVALID" });
          return;
        }
        const expires = cert.valid_to ? new Date(cert.valid_to) : null;
        finish({ valid: true, expiresAt: expires, error: null });
      },
    );

    socket.setTimeout(TLS_TIMEOUT_MS, () => {
      finish({ valid: false, expiresAt: null, error: "TIMEOUT" });
    });

    socket.on("error", (err: NodeJS.ErrnoException) => {
      const code = err.code ?? "";
      let fetchError: FetchError = "SSL_HANDSHAKE";
      if (code === "CERT_HAS_EXPIRED") fetchError = "CERT_EXPIRED";
      else if (
        code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
        code === "SELF_SIGNED_CERT_IN_CHAIN" ||
        code === "DEPTH_ZERO_SELF_SIGNED_CERT"
      )
        fetchError = "CERT_INVALID";
      else if (code === "ENOTFOUND") fetchError = "DNS_FAIL";
      else if (code === "ECONNREFUSED") fetchError = "CONNECTION_REFUSED";
      else if (code === "ETIMEDOUT") fetchError = "TIMEOUT";
      finish({ valid: false, expiresAt: null, error: fetchError });
    });
  });
}

// Checks whether http:// redirects to https://. A plain 200 over HTTP with no
// upgrade is a strong negative signal for a business site in 2026. Returns
// null if the probe itself failed (can't tell → don't penalize blindly).
async function probeHttpRedirect(hostname: string): Promise<boolean | null> {
  const res = await fetchUrl(`http://${hostname}/`, {
    timeoutMs: 5_000,
    retries: 0,
  });
  if (res.error && res.status === 0) return null;
  try {
    const finalUrl = new URL(res.finalUrl);
    return finalUrl.protocol === "https:";
  } catch {
    return null;
  }
}

// Two probes in parallel: raw TLS (for cert validity + expiry) and HTTP→HTTPS
// redirect detection via fetchUrl. Combined into a single result so the audit
// pipeline gets every transport signal from one call.
export async function checkTransport(
  hostname: string,
): Promise<SslCheckResult> {
  const [tlsResult, redirectResult] = await Promise.all([
    probeTls(hostname),
    probeHttpRedirect(hostname),
  ]);

  return {
    sslValid: tlsResult.error ? false : tlsResult.valid,
    sslExpiresAt: tlsResult.expiresAt,
    httpToHttpsRedirect: redirectResult,
    fetchError: tlsResult.error,
  };
}
