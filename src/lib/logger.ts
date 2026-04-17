const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const currentLevel = (process.env.LEADGEN_LOG_LEVEL ?? "info") as Level;
const threshold = LEVELS[currentLevel] ?? LEVELS.info;

function fmt(level: Level, scope: string, msg: string, extra?: unknown) {
  const ts = new Date().toISOString();
  const base = `${ts} [${level.toUpperCase()}] [${scope}] ${msg}`;
  if (extra === undefined) return base;
  return `${base} ${typeof extra === "string" ? extra : JSON.stringify(extra)}`;
}

export function makeLogger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => {
      if (LEVELS.debug >= threshold) console.log(fmt("debug", scope, msg, extra));
    },
    info: (msg: string, extra?: unknown) => {
      if (LEVELS.info >= threshold) console.log(fmt("info", scope, msg, extra));
    },
    warn: (msg: string, extra?: unknown) => {
      if (LEVELS.warn >= threshold) console.warn(fmt("warn", scope, msg, extra));
    },
    error: (msg: string, extra?: unknown) => {
      if (LEVELS.error >= threshold) console.error(fmt("error", scope, msg, extra));
    },
  };
}
