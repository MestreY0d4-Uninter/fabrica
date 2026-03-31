import { defineConfig } from "vitest/config";

const isE2ERun = process.env.VITEST_E2E === "1";

export default defineConfig({
  test: {
    include: [
      "tests/**/*.test.ts",
      "lib/services/**/*.test.ts",
      "lib/services/heartbeat/health.test.ts",
      "lib/providers/provider-pr-status.test.ts",
      "lib/setup/workspace.test.ts",
    ],
    exclude: isE2ERun ? [] : ["**/*.e2e.test.ts"],
  },
});
