import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ageDays,
  cacheFilePath,
  hashQuery,
  indexFilePath,
  isStale,
  readCache,
  readIndex,
  writeCache,
  writeIndex,
  type CacheIndexEntry,
} from "../../src/tools/datasources/osm-overpass-cache.js";

describe("hashQuery", () => {
  it("is stable for identical input", () => {
    expect(hashQuery("foo")).toBe(hashQuery("foo"));
  });

  it("differs for different input", () => {
    expect(hashQuery("foo")).not.toBe(hashQuery("bar"));
  });

  it("produces hex sha256 (64 chars)", () => {
    expect(hashQuery("x")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is whitespace-sensitive (queries must match exactly)", () => {
    expect(hashQuery("foo ")).not.toBe(hashQuery("foo"));
  });
});

describe("isStale", () => {
  it("returns false for a fresh entry", () => {
    const entry: CacheIndexEntry = {
      createdAt: Date.now() - 1_000,
      query: "q",
      resultCount: 0,
    };
    expect(isStale(entry, 14)).toBe(false);
  });

  it("returns true when older than TTL", () => {
    const entry: CacheIndexEntry = {
      createdAt: Date.now() - 15 * 86_400_000,
      query: "q",
      resultCount: 0,
    };
    expect(isStale(entry, 14)).toBe(true);
  });

  it("treats exact-TTL as still fresh (strict greater-than)", () => {
    const now = 1_000_000_000_000;
    const entry: CacheIndexEntry = {
      createdAt: now - 14 * 86_400_000,
      query: "q",
      resultCount: 0,
    };
    expect(isStale(entry, 14, now)).toBe(false);
  });
});

describe("ageDays", () => {
  it("is 0 for just-created", () => {
    const now = Date.now();
    expect(ageDays(now, now)).toBe(0);
  });

  it("floors to whole days", () => {
    const now = 86_400_000 * 10;
    expect(ageDays(0, now)).toBe(10);
  });
});

describe("cache read/write round-trip", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "osm-cache-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("writes and reads payload by hash", async () => {
    const hash = hashQuery("my-query");
    const payload = { elements: [{ type: "node", id: 1 }] };
    await writeCache(dir, hash, payload);
    const read = await readCache<typeof payload>(dir, hash);
    expect(read).toEqual(payload);
  });

  it("writes and reads index round-trip", async () => {
    const index = {
      abc: { createdAt: 123, query: "q1", resultCount: 4 },
    };
    await writeIndex(dir, index);
    const read = await readIndex(dir);
    expect(read).toEqual(index);
  });

  it("readCache returns null for missing file", async () => {
    expect(await readCache(dir, "doesnotexist")).toBeNull();
  });

  it("readIndex returns empty object when index file missing", async () => {
    expect(await readIndex(dir)).toEqual({});
  });

  it("stale-file check via filesystem", async () => {
    const query = "stale-query";
    const hash = hashQuery(query);
    const oldTs = Date.now() - 20 * 86_400_000;
    await writeCache(dir, hash, { elements: [] });
    await writeIndex(dir, {
      [hash]: { createdAt: oldTs, query, resultCount: 0 },
    });
    const index = await readIndex(dir);
    const entry = index[hash];
    expect(entry).toBeDefined();
    expect(isStale(entry!, 14)).toBe(true);
  });

  it("readIndex returns empty object on malformed JSON", async () => {
    await writeFile(indexFilePath(dir), "{ not-json", "utf8");
    expect(await readIndex(dir)).toEqual({});
  });

  it("paths are deterministic under the cache dir", () => {
    expect(cacheFilePath(dir, "abc")).toBe(join(dir, "abc.json"));
    expect(indexFilePath(dir)).toBe(join(dir, "index.json"));
  });

  it("written cache file is valid JSON on disk", async () => {
    const hash = hashQuery("disk-check");
    await writeCache(dir, hash, { foo: 42 });
    const raw = await readFile(cacheFilePath(dir, hash), "utf8");
    expect(JSON.parse(raw)).toEqual({ foo: 42 });
  });
});
