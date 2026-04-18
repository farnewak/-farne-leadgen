// Tiny shared sleep helper. Several modules need the same promise-based
// setTimeout wrapper; duplicating it invites subtle drift (e.g. one version
// swallowing unref semantics). Keep all callers funneled through here.
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
