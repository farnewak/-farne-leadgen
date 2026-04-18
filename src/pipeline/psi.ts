import type { FetchError } from "../models/audit.js";
import { googleApiKey } from "../lib/env.js";
import { sleep } from "../lib/sleep.js";
import { makeLogger } from "../lib/logger.js";

const log = makeLogger("psi");

const PSI_ENDPOINT =
  "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const PSI_TIMEOUT_MS = 60_000;
// Exponential backoff: PSI quota errors recover slowly; a tight retry loop
// just burns the remaining budget. 5/15/45 gives the upstream time to cool.
const BACKOFFS_MS = [5_000, 15_000, 45_000] as const;
const MAX_RETRIES = BACKOFFS_MS.length;

export interface PsiMobileResult {
  performance: number | null;
  seo: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  // Always set, even on error. Acts as a negative-cache anchor: the
  // psiSignalsExpiresAt column is computed from this ∪ env.AUDIT_PSI_TTL_DAYS.
  fetchedAt: Date;
  error: FetchError | null;
}

interface LighthouseCategory {
  score?: number | null;
}
interface PsiResponseBody {
  lighthouseResult?: {
    categories?: {
      performance?: LighthouseCategory;
      seo?: LighthouseCategory;
      accessibility?: LighthouseCategory;
      "best-practices"?: LighthouseCategory;
    };
  };
  error?: {
    code?: number;
    message?: string;
    errors?: Array<{ reason?: string; message?: string }>;
  };
}

function extractScore(cat: LighthouseCategory | undefined): number | null {
  const s = cat?.score;
  if (s == null || !Number.isFinite(s)) return null;
  return Math.round(s * 100);
}

// Error mapping per spec §C. Body is parsed JSON (may be undefined). 403 is
// ambiguous — PSI returns "API key not valid" for AUTH and "Quota exceeded"
// for quota; we inspect the message to pick the right code.
function classify403(body: PsiResponseBody | null): FetchError {
  const msg =
    body?.error?.message?.toLowerCase() ??
    body?.error?.errors?.[0]?.message?.toLowerCase() ??
    "";
  if (msg.includes("api key")) return "AUTH_ERROR";
  if (msg.includes("quota")) return "QUOTA_EXCEEDED";
  return "CLIENT_ERROR";
}

function buildUrl(target: string, apiKey: string | undefined): string {
  // PSI accepts `category` repeated; URL class handles that via appendSearch.
  const u = new URL(PSI_ENDPOINT);
  u.searchParams.set("url", target);
  u.searchParams.set("strategy", "mobile");
  for (const cat of ["performance", "seo", "accessibility", "best-practices"]) {
    u.searchParams.append("category", cat);
  }
  if (apiKey) u.searchParams.set("key", apiKey);
  return u.toString();
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 504);
}

function isRetryableCode(code: string | undefined): boolean {
  return code === "ECONNRESET" || code === "ETIMEDOUT";
}

interface OneShotResult {
  body: PsiResponseBody | null;
  status: number;
  timedOut: boolean;
  errorCode: string | undefined;
}

async function oneShot(url: string): Promise<OneShotResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PSI_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });
    clearTimeout(timer);
    const text = await res.text();
    let body: PsiResponseBody | null = null;
    try {
      body = JSON.parse(text) as PsiResponseBody;
    } catch {
      body = null;
    }
    return { body, status: res.status, timedOut: false, errorCode: undefined };
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return { body: null, status: 0, timedOut: true, errorCode: "ETIMEDOUT" };
    }
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : undefined;
    return { body: null, status: 0, timedOut: false, errorCode: code };
  }
}

function emptyResult(error: FetchError | null): PsiMobileResult {
  return {
    performance: null,
    seo: null,
    accessibility: null,
    bestPractices: null,
    fetchedAt: new Date(),
    error,
  };
}

// Runs PSI mobile strategy with retries. Always resolves (never throws) —
// callers mix this with other signal extractors under Promise.all and the
// per-item error field carries the failure mode downstream.
export async function runPsiMobile(url: string): Promise<PsiMobileResult> {
  const key = googleApiKey();
  const requestUrl = buildUrl(url, key);

  let lastError: FetchError = "UNKNOWN";
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const shot = await oneShot(requestUrl);

    if (shot.timedOut) {
      lastError = "TIMEOUT";
    } else if (shot.status === 200 && shot.body) {
      const cats = shot.body.lighthouseResult?.categories;
      return {
        performance: extractScore(cats?.performance),
        seo: extractScore(cats?.seo),
        accessibility: extractScore(cats?.accessibility),
        bestPractices: extractScore(cats?.["best-practices"]),
        fetchedAt: new Date(),
        error: null,
      };
    } else if (shot.status === 429) {
      lastError = "RATE_LIMITED";
    } else if (shot.status === 400) {
      // Invalid URL — not retryable. Surface immediately.
      return emptyResult("CLIENT_ERROR");
    } else if (shot.status === 403) {
      // AUTH or quota — not retryable either way.
      return emptyResult(classify403(shot.body));
    } else if (shot.status >= 500 && shot.status <= 504) {
      lastError = "SERVER_ERROR";
    } else if (shot.status >= 400) {
      // Other 4xx — not retryable.
      return emptyResult("CLIENT_ERROR");
    } else if (isRetryableCode(shot.errorCode)) {
      lastError = shot.errorCode === "ETIMEDOUT" ? "TIMEOUT" : "SERVER_ERROR";
    } else {
      lastError = "UNKNOWN";
    }

    const retryable =
      shot.timedOut ||
      isRetryableStatus(shot.status) ||
      isRetryableCode(shot.errorCode);
    if (!retryable || attempt >= MAX_RETRIES) break;

    const wait = BACKOFFS_MS[attempt] ?? BACKOFFS_MS[BACKOFFS_MS.length - 1]!;
    log.warn(`PSI retry ${attempt + 1}/${MAX_RETRIES} in ${wait}ms (last=${lastError})`);
    await sleep(wait);
  }

  return emptyResult(lastError);
}
