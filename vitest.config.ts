import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/**/*.test.ts",
      "lib/services/**/*.test.ts",
      "lib/services/heartbeat/health.test.ts",
      "lib/providers/provider-pr-status.test.ts",
      "lib/setup/workspace.test.ts",
    ],
  },
});
