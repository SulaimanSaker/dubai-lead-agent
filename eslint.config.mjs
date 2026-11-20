import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import prettier from "eslint-config-prettier/flat";

/**
 * Architecture boundaries (see docs/architecture.md).
 *
 * Layers: app → agent → tools → db. A layer may only import from layers to its right.
 * Only src/agent/llm/ may talk to a model provider SDK.
 *
 * Note: in flat config, two config objects that both set `no-restricted-imports`
 * for the same file do NOT merge — the later one wins. So each layer's rule is
 * built with `restrict(...)`, which always adds the shared rules too.
 */
const PROVIDER_SDKS = [
  {
    group: ["@anthropic-ai/sdk", "@anthropic-ai/sdk/*", "openai", "openai/*"],
    message:
      "Model provider SDKs may only be imported inside src/agent/llm/ (see docs/architecture.md).",
  },
];

const TRACING_SDKS = [
  {
    group: ["@langfuse/*", "@opentelemetry/*"],
    message:
      "Tracing SDKs may only be imported inside src/agent/tracing/ (see docs/decisions/0005-tracing.md).",
  },
];

const NO_PARENT_RELATIVE = [
  {
    group: ["../*"],
    message:
      "Use the @/ alias instead of ../ imports, so layer boundaries stay visible and enforceable.",
  },
];

const layer = (names, why) => ({
  group: names.flatMap((n) => [`@/${n}`, `@/${n}/*`]),
  message: why,
});

const restrict = (...patterns) => ["error", { patterns: [...NO_PARENT_RELATIVE, ...patterns] }];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  prettier,

  {
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },

  // Default for all source files: no provider SDKs, no ../ imports.
  {
    files: ["src/**/*.{ts,tsx}", "evals/**/*.ts", "scripts/**/*.ts"],
    rules: { "no-restricted-imports": restrict(...PROVIDER_SDKS, ...TRACING_SDKS) },
  },
  // app: UI + routes. Talks to the agent only — never to tools or db directly.
  {
    files: ["src/app/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": restrict(
        ...PROVIDER_SDKS,
        ...TRACING_SDKS,
        layer(
          ["tools", "db"],
          "app/ must go through @/agent — not tools or db directly (docs/architecture.md).",
        ),
        {
          group: ["@/agent/*"],
          message:
            "app/ uses the agent's public API: import from @/agent (src/agent/index.ts), not its internals.",
        },
      ),
    },
  },
  // agent: may use tools and its own llm/ layer, never the UI.
  {
    files: ["src/agent/**/*.ts"],
    ignores: ["src/agent/llm/**", "src/agent/tracing/**"],
    rules: {
      "no-restricted-imports": restrict(
        ...PROVIDER_SDKS,
        ...TRACING_SDKS,
        layer(["app"], "agent/ must not import from app/ (layers only point right)."),
      ),
    },
  },
  // agent/llm: the ONLY place provider SDKs are allowed.
  {
    files: ["src/agent/llm/**/*.ts"],
    rules: {
      "no-restricted-imports": restrict(
        ...TRACING_SDKS,
        layer(
          ["app", "tools", "db"],
          "agent/llm/ only adapts model providers; it must not reach into app, tools or db.",
        ),
      ),
    },
  },
  // agent/tracing: the ONLY place tracing SDKs are allowed. No provider SDKs, never the UI.
  {
    files: ["src/agent/tracing/**/*.ts"],
    rules: {
      "no-restricted-imports": restrict(
        ...PROVIDER_SDKS,
        layer(["app"], "agent/tracing/ must not import from app/ (layers only point right)."),
      ),
    },
  },
  // tools: may use db, never agent or app.
  {
    files: ["src/tools/**/*.ts"],
    rules: {
      "no-restricted-imports": restrict(
        ...PROVIDER_SDKS,
        ...TRACING_SDKS,
        layer(
          ["app", "agent"],
          "tools/ must not import from agent/ or app/ (layers only point right).",
        ),
      ),
    },
  },
  // db: the bottom layer, imports no other layer.
  {
    files: ["src/db/**/*.ts"],
    rules: {
      "no-restricted-imports": restrict(
        ...PROVIDER_SDKS,
        ...TRACING_SDKS,
        layer(
          ["app", "agent", "tools"],
          "db/ is the bottom layer and must not import other layers.",
        ),
      ),
    },
  },

  // evals: run the agent like the app does, plus tools and db for setup and checks; never the UI.
  {
    files: ["evals/**/*.ts"],
    rules: {
      "no-restricted-imports": restrict(
        ...PROVIDER_SDKS,
        ...TRACING_SDKS,
        layer(["app"], "evals/ test the agent, not the UI: they must not import from app/."),
      ),
    },
  },

  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "coverage/**",
    "evals/report/build-report-lite.mjs", // vendored from Anthropic's claude-api skill
    "evals/runs/**",
  ]),
]);

export default eslintConfig;
