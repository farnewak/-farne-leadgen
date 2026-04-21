import { z } from "zod";

// Stage-1 results contract (FIX 13). This schema is the single source of
// truth for:
//   - TypeScript row typing                → `Stage1ResultRow`
//   - CSV header / column order            → `STAGE1_COLUMNS`
//   - JSON key order                       → `STAGE1_COLUMNS`
//   - Runtime invariant check              → `Stage1ResultSchema`
//
// Any addition to this schema requires bumping the DB migrations AND
// updating ARCHITECTURE_MAP.md > "Schema freeze" in the SAME commit.
// The invariant check in `assertExportInvariants` will throw if any
// row's keys deviate from this order.

const TierSchema = z.enum(["A", "B1", "B2", "B3", "C"]);
const SubTierSchema = z.union([z.enum(["A1", "A2", "A3"]), z.null()]);
const IntentTierSchema = z
  .enum(["PARKED", "DEAD", "DEAD_WEBSITE", "LIVE", "NONE", "AUDIT_ERROR", "TIMEOUT"])
  .nullable();
const BreakdownEntrySchema = z.object({
  key: z.string(),
  delta: z.number(),
});

// Column order is enforced. Zod object keys preserve definition order at
// runtime (ECMA: string-keyed own properties iterate in insertion order
// modulo integer-like keys), so `Object.keys(shape)` matches the
// contract. Consumers must use `STAGE1_COLUMNS` when serialising.
export const Stage1ResultSchema = z.object({
  place_id: z.string(),
  tier: TierSchema,
  sub_tier: SubTierSchema,
  intent_tier: IntentTierSchema,
  chain_detected: z.boolean(),
  chain_name: z.string().nullable(),
  branch_count: z.number().int(),
  score: z.number().nullable(),
  name: z.string(),
  url: z.string().nullable(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  email_is_generic: z.union([z.literal(0), z.literal(1), z.null()]),
  address: z.string().nullable(),
  plz: z.string().nullable(),
  uid: z.string().nullable(),
  impressum_complete: z.boolean().nullable(),
  psi_mobile_performance: z.number().nullable(),
  ssl_valid: z.boolean().nullable(),
  cms: z.string(),
  has_structured_data: z.boolean().nullable(),
  last_modified_signal: z.number().int().nullable(),
  has_social: z.boolean(),
  audited_at: z.date(),
  score_breakdown: z.array(BreakdownEntrySchema),
});

export type Stage1ResultRow = z.infer<typeof Stage1ResultSchema>;

// Frozen column order. Derived from the schema shape so the two can
// never drift: adding a key to the schema automatically extends this
// list. Exported as a readonly tuple so consumers (CSV header, JSON
// key emission, column-order invariant) all share one definition.
export const STAGE1_COLUMNS = Object.keys(
  Stage1ResultSchema.shape,
) as ReadonlyArray<keyof Stage1ResultRow>;

// Asserts that `row`'s own-key sequence matches STAGE1_COLUMNS exactly.
// Throws with a precise diff so schema-drift failures are actionable.
// Called by `assertExportInvariants` on every row just before return.
export function assertColumnOrder(row: Record<string, unknown>, rowId: string): void {
  const actual = Object.keys(row);
  if (actual.length !== STAGE1_COLUMNS.length) {
    throw new Error(
      `stage1 schema violation (row ${rowId}): expected ${STAGE1_COLUMNS.length} keys, got ${actual.length}`,
    );
  }
  for (let i = 0; i < STAGE1_COLUMNS.length; i++) {
    if (actual[i] !== STAGE1_COLUMNS[i]) {
      throw new Error(
        `stage1 schema violation (row ${rowId}): key[${i}] expected='${STAGE1_COLUMNS[i]}', got='${actual[i]}'`,
      );
    }
  }
}
