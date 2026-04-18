import pLimit from "p-limit";
import { sleep } from "./sleep.js";
import { loadEnv } from "./env.js";

// Single global concurrency limiter for the entire audit phase. Sized from
// AUDIT_CONCURRENCY — the default 10 means we never burn more than 10 TCP
// conns / TLS handshakes at once, independent of host distribution.
const globalLimit = pLimit(loadEnv().AUDIT_CONCURRENCY);

// Per-host serialization chain. The map stores the *tail* of the chain; each
// new task chains onto it so tasks on the same host run sequentially, with
// AUDIT_MIN_DELAY_PER_HOST_MS between successive completions.
const perHost = new Map<string, Promise<void>>();

// Test-only introspection. Exported so the host-limiter.test.ts can assert
// that cleanup doesn't leak entries across runs — a real bug we want regression
// coverage for. Do NOT read from production code.
export function __getMapSize(): number {
  return perHost.size;
}

// Schedules `task` to run under the global concurrency limit and after the
// previous task on `host` has completed (and observed the polite delay).
// INVARIANT: the slot held by globalLimit is released only *after* the
// post-task sleep. This makes host-starvation impossible at the cost of
// temporarily holding a slot during the sleep — acceptable at concurrency 10.
export function schedule<T>(
  host: string,
  task: () => Promise<T>,
): Promise<T> {
  return globalLimit(async () => {
    const prev = perHost.get(host) ?? Promise.resolve();

    // Chain we publish: resolves when our task + sleep are fully done, so
    // the NEXT scheduled task on this host waits for us.
    let resolveChain!: () => void;
    const chain = new Promise<void>((r) => {
      resolveChain = r;
    });
    // `chained` = "wait for the previous tail, then our own completion".
    // We store `chained` in the map — NOT `chain` — because successor tasks
    // must wait for the whole pipeline, not just our inner settle signal.
    const chained: Promise<void> = prev.then(() => chain);
    perHost.set(host, chained);

    await prev;
    try {
      const result = await task();
      await sleep(loadEnv().AUDIT_MIN_DELAY_PER_HOST_MS);
      return result;
    } finally {
      resolveChain();
      // Cleanup: only delete the entry if we're still the tail. If another
      // task enqueued after us, it replaced the entry with its own chained
      // promise and we must leave it alone.
      if (perHost.get(host) === chained) perHost.delete(host);
    }
  });
}
