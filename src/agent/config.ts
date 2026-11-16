import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z
    .preprocess((value) => (value === "" ? undefined : value), z.string().optional())
    .transform((value) => value ?? "file:local.db")
    .refine((value) => value === ":memory:" || /^(file|libsql|https?|wss?):/.test(value), {
      message: 'Use "file:local.db", ":memory:" or a libsql:// URL.',
    }),
});

export type AppConfig = z.output<typeof envSchema>;

/** App settings from the environment, validated. Model settings live in src/agent/llm/config.ts. */
export function readAppConfig(env: Record<string, string | undefined> = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid app settings in the environment:\n${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
