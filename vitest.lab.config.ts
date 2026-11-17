import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["lab/tests/**/*.test.ts"],
    coverage: { reporter: ["text", "json-summary"] },
  },
});
