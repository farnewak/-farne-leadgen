import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as sqliteSchema from "./schema.sqlite.js";
import * as pgSchema from "./schema.pg.js";

export type Db =
  | ReturnType<typeof drizzleSqlite<typeof sqliteSchema>>
  | ReturnType<typeof drizzlePg<typeof pgSchema>>;

let cached: Db | null = null;

export function getDb(): Db {
  if (cached) return cached;
  const url = process.env.DATABASE_URL ?? "file:./runs/leadgen.db";

  if (url.startsWith("postgres://") || url.startsWith("postgresql://")) {
    const sql = postgres(url, { max: 1 });
    cached = drizzlePg(sql, { schema: pgSchema });
    return cached;
  }

  const filePath = url.replace(/^file:/, "");
  const absPath = path.isAbsolute(filePath)
    ? filePath
    : path.resolve(process.cwd(), filePath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const sqlite = new Database(absPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  cached = drizzleSqlite(sqlite, { schema: sqliteSchema });
  return cached;
}

export function isPostgres(): boolean {
  const url = process.env.DATABASE_URL ?? "";
  return url.startsWith("postgres://") || url.startsWith("postgresql://");
}

// Test-only: forces the next getDb() call to reopen the connection.
// Used by the integration test to swap DATABASE_URL between fixtures.
// Do NOT call from production code.
export function __resetDbClientForTests(): void {
  cached = null;
}
