import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { resetEnvCache } from "../../src/lib/env.js";

// env values must be stubbed *before* importing host-limiter, because
// AUDIT_CONCURRENCY is read at module-load time via pLimit().
async function importFresh(): Promise<typeof import("../../src/lib/host-limiter.js")> {
  vi.resetModules();
  return await import("../../src/lib/host-limiter.js");
}

describe("schedule (host-limiter)", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    vi.stubEnv("AUDIT_CONCURRENCY", "10");
    vi.stubEnv("AUDIT_MIN_DELAY_PER_HOST_MS", "50");
    resetEnvCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it("10 tasks on 10 distinct hosts all start within 50ms", async () => {
    const { schedule } = await importFresh();
    const startTimes: number[] = [];
    const runStart = Date.now();
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        schedule(`host-${i}`, async () => {
          startTimes.push(Date.now() - runStart);
          await new Promise((r) => setTimeout(r, 5));
        }),
      ),
    );
    for (const t of startTimes) expect(t).toBeLessThan(100);
  });

  it("tasks on same host run sequentially with min-delay", async () => {
    const { schedule } = await importFresh();
    const order: string[] = [];
    const start = Date.now();
    await Promise.all([
      schedule("same", async () => {
        order.push(`a:${Date.now() - start}`);
      }),
      schedule("same", async () => {
        order.push(`b:${Date.now() - start}`);
      }),
      schedule("same", async () => {
        order.push(`c:${Date.now() - start}`);
      }),
    ]);
    expect(order).toHaveLength(3);
    // Each successor should start after prev finished + 50ms delay.
    const times = order.map((s) => Number.parseInt(s.split(":")[1]!, 10));
    expect(times[1]! - times[0]!).toBeGreaterThanOrEqual(40);
    expect(times[2]! - times[1]!).toBeGreaterThanOrEqual(40);
  });

  it("exception in one task does not freeze the host chain", async () => {
    const { schedule } = await importFresh();
    await expect(
      schedule("h", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Subsequent task on same host must run.
    const r = await schedule("h", async () => "ok");
    expect(r).toBe("ok");
  });

  it("map cleans up after all tasks on a host finish", async () => {
    const mod = await importFresh();
    // Spin 20 distinct hosts, wait for all, then check map.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        mod.schedule(`leak-${i}`, async () => {
          await new Promise((r) => setTimeout(r, 1));
        }),
      ),
    );
    // Allow microtask-queue drain for cleanup in the `finally` blocks.
    await new Promise((r) => setTimeout(r, 100));
    expect(mod.__getMapSize()).toBe(0);
  });
});
