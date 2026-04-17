import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { migrate as migrateSqlite } from "drizzle-orm/better-sqlite3/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

async function main() {
  const url = process.env.DATABASE_URL ?? "file:./runs/leadgen.db";
  const isPg = url.startsWith("postgres://") || url.startsWith("postgresql://");

  if (isPg) {
    const sql = postgres(url, { max: 1 });
    const db = drizzlePg(sql);
    await migratePg(db, { migrationsFolder: "./src/db/migrations/pg" });
    await sql.end();
    console.log("[migrate] postgres migrations applied");
    return;
  }

  const filePath = url.replace(/^file:/, "");
  const absPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const sqlite = new Database(absPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzleSqlite(sqlite);
  migrateSqlite(db, { migrationsFolder: "./src/db/migrations/sqlite" });
  sqlite.close();
  console.log(`[migrate] sqlite migrations applied → ${absPath}`);
}

main().catch((err) => {
  console.error("[migrate] failed:", err);
  process.exit(1);
});
