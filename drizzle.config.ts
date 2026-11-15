import { defineConfig } from "drizzle-kit";

// Used by `npm run db:generate` to turn changes in src/db/schema.ts into SQL migrations.
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
});
