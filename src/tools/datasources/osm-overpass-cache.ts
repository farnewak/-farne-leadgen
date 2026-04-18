import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Cache layer for Overpass responses. Index is keyed by sha256(query) —
// identical query text ⇒ identical key. Stored JSON payload is opaque to
// the cache (`unknown`); callers own the schema.

export interface CacheIndexEntry {
  createdAt: number; // epoch ms at write time
  query: string; // raw Overpass query text
  resultCount: number;
}

export type CacheIndex = Record<string, CacheIndexEntry>;

export function hashQuery(query: string): string {
  return createHash("sha256").update(query).digest("hex");
}

export function cacheFilePath(cacheDir: string, hash: string): string {
  return join(cacheDir, `${hash}.json`);
}

export function indexFilePath(cacheDir: string): string {
  return join(cacheDir, "index.json");
}

export async function readIndex(cacheDir: string): Promise<CacheIndex> {
  try {
    const raw = await readFile(indexFilePath(cacheDir), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") return parsed as CacheIndex;
    return {};
  } catch {
    return {};
  }
}

export async function writeIndex(
  cacheDir: string,
  index: CacheIndex,
): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(indexFilePath(cacheDir), JSON.stringify(index, null, 2), "utf8");
}

export async function readCache<T>(
  cacheDir: string,
  hash: string,
): Promise<T | null> {
  try {
    const raw = await readFile(cacheFilePath(cacheDir, hash), "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeCache(
  cacheDir: string,
  hash: string,
  data: unknown,
): Promise<void> {
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cacheFilePath(cacheDir, hash), JSON.stringify(data), "utf8");
}

export function isStale(
  entry: CacheIndexEntry,
  ttlDays: number,
  now: number = Date.now(),
): boolean {
  return now - entry.createdAt > ttlDays * 86_400_000;
}

export function ageDays(createdAt: number, now: number = Date.now()): number {
  return Math.max(0, Math.floor((now - createdAt) / 86_400_000));
}
