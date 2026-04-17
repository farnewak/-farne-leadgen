// Hard per-row truncation budget for snapshots.raw_audit.
// SQLite swallows anything, but a single runaway Lighthouse JSON-report can
// exceed 1MB and bloats the DB non-linearly over time. Enforced App-side
// in src/pipeline/persist.ts:writeSnapshot — truncate + warn, never throw.
export const MAX_RAW_AUDIT_BYTES = 500_000; // 500 kB
