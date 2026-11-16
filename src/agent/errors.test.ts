import { describe, expect, it } from "vitest";
import { isDatabaseNotReady } from "@/agent/errors";
import { createDb } from "@/db/client";
import { leads } from "@/db/schema";

describe("isDatabaseNotReady", () => {
  it("recognises a real query on a database without tables (error wrapped by Drizzle)", async () => {
    const empty = createDb(":memory:");
    const error = await empty
      .select()
      .from(leads)
      .then(() => null)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(isDatabaseNotReady(error)).toBe(true);
  });

  it("is false for other errors", () => {
    expect(isDatabaseNotReady(new Error("connection refused"))).toBe(false);
    expect(isDatabaseNotReady("no such table")).toBe(false);
    expect(isDatabaseNotReady(undefined)).toBe(false);
  });
});
