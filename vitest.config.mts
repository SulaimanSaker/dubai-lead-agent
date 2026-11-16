import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Tests run outside a React server build; use the package's own no-op build for server code.
      "server-only": fileURLToPath(new URL("./node_modules/server-only/empty.js", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "evals/**/*.test.ts"],
    // Eval runs call real models and cost money — they are NOT unit tests.
    // Run them with `npm run evals` (added in Phase 4).
    exclude: ["node_modules", "evals/cases/**", "evals/reports/**"],
    passWithNoTests: true,
  },
});
