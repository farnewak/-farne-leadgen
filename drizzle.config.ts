import "dotenv/config";
import type { Config } from "drizzle-kit";

const url = process.env.DATABASE_URL ?? "file:./runs/leadgen.db";
const isPg = url.startsWith("postgres://") || url.startsWith("postgresql://");

export default {
  dialect: isPg ? "postgresql" : "sqlite",
  schema: isPg ? "./src/db/schema.pg.ts" : "./src/db/schema.sqlite.ts",
  out: isPg ? "./src/db/migrations/pg" : "./src/db/migrations/sqlite",
  dbCredentials: isPg
    ? { url }
    : { url: url.replace(/^file:/, "") },
  strict: true,
  verbose: true,
} satisfies Config;
