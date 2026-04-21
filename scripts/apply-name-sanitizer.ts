// Retroactively apply the Phase 7b sanitizer to an existing Stage-1 DB.
//
// Simulates the effect of `runAudit --force --bezirk 1010` for the
// narrow case of the `impressum_company_name` column: the row-builder
// sanitizer (src/pipeline/audit-row-builders.ts) is the only code path
// that writes to this column, and it is a pure function of the stored
// `scraped.companyName` value. So reading the current value and writing
// the sanitizer's output is bit-identical to what a post-fix audit
// would persist, without re-running the network pipeline (PSI,
// Overpass, impressum-scraper).
//
// Usage:
//   pnpm tsx scripts/apply-name-sanitizer.ts runs/phase6.db
//
// Reports a before/after table on stdout and returns exit 0 on clean
// finish.

import Database from "better-sqlite3";
import { sanitizeCompanyName } from "../src/pipeline/sanitize-company-name.js";

interface Row {
  id: number;
  place_id: string;
  tier: string;
  impressum_company_name: string | null;
}

function main(): void {
  const dbPath = process.argv[2];
  if (!dbPath) {
    process.stderr.write("usage: apply-name-sanitizer <db-path>\n");
    process.exit(1);
  }

  const db = new Database(dbPath);
  const rows = db
    .prepare(
      "SELECT id, place_id, tier, impressum_company_name FROM audit_results",
    )
    .all() as Row[];

  const update = db.prepare(
    "UPDATE audit_results SET impressum_company_name = ? WHERE id = ?",
  );

  type Change = { place_id: string; tier: string; before: string; after: string | null };
  const changes: Change[] = [];

  const tx = db.transaction(() => {
    for (const r of rows) {
      const before = r.impressum_company_name;
      const after = sanitizeCompanyName(before);
      if (after !== before) {
        update.run(after, r.id);
        changes.push({
          place_id: r.place_id,
          tier: r.tier,
          before: before ?? "(null)",
          after,
        });
      }
    }
  });
  tx();

  process.stdout.write(`rows inspected: ${rows.length}\n`);
  process.stdout.write(`rows changed:   ${changes.length}\n`);
  for (const c of changes) {
    process.stdout.write(
      `  ${c.place_id} (${c.tier}): before=${JSON.stringify(c.before)} after=${JSON.stringify(c.after)}\n`,
    );
  }
  db.close();
}

main();
