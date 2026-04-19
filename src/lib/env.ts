import "dotenv/config";
import { z } from "zod";

// z.coerce.boolean() converts "false" → true (any non-empty string is truthy).
// Custom helper: only the four explicit strings are accepted, everything else
// throws. `.default()` chains pre-transform so the default propagates as a
// string through the enum before being coerced to a real boolean.
function boolEnvField(defaultStr: "true" | "false") {
  return z
    .enum(["true", "false", "1", "0"])
    .default(defaultStr)
    .transform((s) => s === "true" || s === "1");
}

// dotenv loads `FOO=` lines as the literal empty string, but downstream code
// expects "unset" when the user leaves a value blank. Normalize "" → undefined
// before the schema runs so defaults + optionals behave consistently.
function stripEmpty(
  raw: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(raw)) {
    out[k] = v === "" ? undefined : v;
  }
  return out;
}

const envSchema = z.object({
  // --- DB ---
  DATABASE_URL: z.string().default("file:./runs/leadgen.db"),

  // --- Pipeline basics ---
  LEADGEN_CITY: z.string().default("Vienna"),
  LEADGEN_LOG_LEVEL: z
    .enum(["debug", "info", "warn", "error"])
    .default("info"),

  // --- Google APIs (unified key, three services) ---
  // v0.2 consolidates on GOOGLE_API_KEY. The legacy names remain accepted
  // so existing .env files keep working; googleApiKey() resolves precedence.
  GOOGLE_API_KEY: z.string().optional(),
  GOOGLE_CSE_ID: z.string().optional(),
  GOOGLE_MAPS_API_KEY: z.string().optional(),
  PAGESPEED_API_KEY: z.string().optional(),

  // --- Anthropic ---
  ANTHROPIC_API_KEY: z.string().optional(),

  // --- OSM Overpass ---
  OVERPASS_ENDPOINT: z
    .string()
    .default("https://overpass-api.de/api/interpreter"),
  OVERPASS_USER_AGENT: z
    .string()
    .default(
      "farne-leadgen/0.1 (+https://farne-solutions.com; contact@farne-solutions.com)",
    ),
  OVERPASS_MAX_REQUESTS_PER_RUN: z.coerce.number().int().min(0).default(40),
  OVERPASS_TIMEOUT_SECONDS: z.coerce.number().int().min(1).default(180),
  OVERPASS_CACHE_DIR: z.string().default("./runs/overpass-cache"),
  OVERPASS_CACHE_TTL_DAYS: z.coerce.number().int().min(0).default(14),
  OVERPASS_MIN_DELAY_MS: z.coerce.number().int().min(0).default(1500),

  // --- Audit pipeline ---
  AUDIT_FETCH_TIMEOUT_MS: z.coerce.number().int().min(1).default(30_000),
  AUDIT_FETCH_RETRIES: z.coerce.number().int().min(0).default(2),
  AUDIT_CONCURRENCY: z.coerce.number().int().min(1).default(10),
  AUDIT_USER_AGENT: z
    .string()
    .default(
      "farne-leadgen-audit/0.1 (+https://farne-solutions.com; contact@farne-solutions.com)",
    ),
  AUDIT_MIN_DELAY_PER_HOST_MS: z.coerce.number().int().min(0).default(1000),
  AUDIT_RESPECT_ROBOTS_TXT: boolEnvField("true"),
  AUDIT_STATIC_TTL_DAYS: z.coerce.number().int().min(0).default(30),
  AUDIT_PSI_TTL_DAYS: z.coerce.number().int().min(0).default(14),

  // --- DNS probe (website discovery) ---
  DNS_PROBE_ENABLED: boolEnvField("true"),
  DNS_PROBE_TLDS: z.string().default("at,com"),

  // --- Custom Search Engine (fallback website discovery) ---
  CSE_DISCOVERY_ENABLED: boolEnvField("false"),
  CSE_MAX_QUERIES_PER_CANDIDATE: z.coerce.number().int().min(0).default(3),

  // --- B3 Google-Places enrichment (contact-coverage P0) ---
  B3_ENRICHMENT_ENABLED: boolEnvField("true"),
  GOOGLE_PLACES_DAILY_QUOTA: z.coerce.number().int().min(0).default(5000),
  PLACES_CACHE_DIR: z.string().default("./runs/places-cache"),
  PLACES_CACHE_TTL_DAYS: z.coerce.number().int().min(0).default(30),
});

export type EnvT = z.infer<typeof envSchema>;

let cached: EnvT | null = null;

export function loadEnv(): EnvT {
  if (cached) return cached;
  const parsed = envSchema.safeParse(stripEmpty(process.env));
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid env: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

// Tests mutate process.env via vi.stubEnv; resetEnvCache() forces the next
// loadEnv() call to re-parse. Do NOT call from production code.
export function resetEnvCache(): void {
  cached = null;
}

// Unified Google API key: prefers GOOGLE_API_KEY, falls back to the legacy
// per-service names. Returns undefined if none is set — callers gate features
// on isConfigured() checks, not on empty-string defaults.
export function googleApiKey(): string | undefined {
  const e = loadEnv();
  return e.GOOGLE_API_KEY ?? e.GOOGLE_MAPS_API_KEY ?? e.PAGESPEED_API_KEY;
}
