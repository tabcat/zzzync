import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // real-helia tests (e.g. zzzync.test.ts) are I/O-variable; give them headroom
    testTimeout: 30_000,
    benchmark: {
      include: ["bench/**/*.bench.ts"],
    },
  },
});
