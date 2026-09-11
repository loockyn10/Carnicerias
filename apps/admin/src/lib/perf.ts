const enabled = process.env.NODE_ENV !== "production" || process.env.ADMIN_PERF_LOGS === "1";

export function createPerfLogger(route: string) {
  const startedAt = performance.now();
  const timings: Record<string, number> = {};

  return {
    async measure<T>(name: string, operation: PromiseLike<T>): Promise<T> {
      const started = performance.now();
      try {
        return await operation;
      } finally {
        timings[name] = Math.round(performance.now() - started);
      }
    },
    mark(name: string, started: number) {
      timings[name] = Math.round(performance.now() - started);
    },
    flush() {
      if (!enabled) return;
      const lines = Object.entries({ ...timings, total: Math.round(performance.now() - startedAt) })
        .map(([name, duration]) => `  ${name}: ${String(duration)}ms`)
        .join("\n");
      console.info(`[PERF ${route}]\n${lines}`);
    }
  };
}
