import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Keep ad hoc runs safe for the real-Git controller slice; the package script parallelizes its shardable remainder.
    maxWorkers: 1,
    reporters: ['dot'],
  },
});
