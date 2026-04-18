import { loadEnv } from "./env.js";
import { makeLogger } from "./logger.js";
import type { FetchError } from "../models/audit.js";

const log = makeLogger("http-fetch");

// 2MB cap on response bodies. Anything larger gets silently truncated —
// downstream extractors only look at <head>-region content plus a small
// window, so 2MB is already generous. Prevents OOM on pathological hosts.
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_ACCEPT_LANG = "de-AT,de;q=0.9,en;q=0.5";
const BACKOFFS_MS = [2_000, 6_000, 18_000] as const;
const RETRYABLE_STATUS = new Set([429, 503, 504]);

export interface FetchOptions {
  timeoutMs?: number;
  retries?: number;
  userAgent?: string;
  acceptLanguage?: string;
}

export interface FetchResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  finalUrl: string;
  error: FetchError | null;
}

function classifyError(err: unknown): FetchError {
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.name === "TimeoutError") return "TIMEOUT";
    const code = extractCode(err);
    if (code === "ENOTFOUND") return "DNS_FAIL";
    if (code === "ECONNREFUSED") return "CONNECTION_REFUSED";
    if (code === "CERT_HAS_EXPIRED") return "CERT_EXPIRED";
    if (code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return "CERT_INVALID";
    if (code === "SELF_SIGNED_CERT_IN_CHAIN") return "CERT_INVALID";
    if (code === "DEPTH_ZERO_SELF_SIGNED_CERT") return "CERT_INVALID";
    if (code === "ERR_SSL_PROTOCOL_ERROR") return "SSL_HANDSHAKE";
    if (code?.startsWith("ERR_TLS")) return "SSL_HANDSHAKE";
  }
  return "UNKNOWN";
}

function extractCode(err: Error): string | undefined {
  const withCause = err as Error & { cause?: unknown; code?: string };
  if (typeof withCause.code === "string") return withCause.code;
  const cause = withCause.cause;
  if (cause && typeof cause === "object" && "code" in cause) {
    const c = (cause as { code: unknown }).code;
    if (typeof c === "string") return c;
  }
  return undefined;
}

function headersToRecord(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

async function readBodyCapped(res: Response): Promise<string> {
  // response.text() already buffers fully; we cap afterwards. A streaming
  // truncator would save memory but complicates charset detection — defer.
  const text = await res.text();
  if (text.length <= MAX_BODY_BYTES) return text;
  log.warn(`body > ${MAX_BODY_BYTES}B, truncating (url=${res.url})`);
  return text.slice(0, MAX_BODY_BYTES);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

export async function fetchUrl(
  url: string,
  opts: FetchOptions = {},
): Promise<FetchResult> {
  const env = loadEnv();
  const timeoutMs = opts.timeoutMs ?? env.AUDIT_FETCH_TIMEOUT_MS;
  const maxRetries = opts.retries ?? env.AUDIT_FETCH_RETRIES;
  const userAgent = opts.userAgent ?? env.AUDIT_USER_AGENT;
  const acceptLanguage = opts.acceptLanguage ?? DEFAULT_ACCEPT_LANG;

  let lastErr: FetchError | null = null;
  let lastStatus = 0;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": userAgent,
          "Accept-Language": acceptLanguage,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      });
      clearTimeout(timer);

      if (RETRYABLE_STATUS.has(res.status) && attempt < maxRetries) {
        const wait = BACKOFFS_MS[Math.min(attempt, BACKOFFS_MS.length - 1)] ?? 18_000;
        log.warn(`${res.status} ${url} — retry ${attempt + 1} in ${wait}ms`);
        lastStatus = res.status;
        await sleep(wait);
        continue;
      }

      const body = await readBodyCapped(res);
      const error: FetchError | null =
        res.status >= 500 ? "HTTP_5XX" : res.status >= 400 ? "HTTP_4XX" : null;
      return {
        status: res.status,
        headers: headersToRecord(res.headers),
        body,
        finalUrl: res.url || url,
        error,
      };
    } catch (err) {
      clearTimeout(timer);
      lastErr = classifyError(err);
      if (attempt < maxRetries && lastErr === "TIMEOUT") {
        const wait = BACKOFFS_MS[Math.min(attempt, BACKOFFS_MS.length - 1)] ?? 18_000;
        log.warn(`${lastErr} ${url} — retry ${attempt + 1} in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      return {
        status: 0,
        headers: {},
        body: "",
        finalUrl: url,
        error: lastErr,
      };
    }
  }

  // Retries exhausted on retryable status codes
  return {
    status: lastStatus,
    headers: {},
    body: "",
    finalUrl: url,
    error: lastStatus >= 500 ? "HTTP_5XX" : "UNKNOWN",
  };
}
