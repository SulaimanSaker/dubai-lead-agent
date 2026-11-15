import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TOOLS, TOOLS_BY_NAME } from "@/tools";

/**
 * Contract for every tool, checked automatically: if someone adds a tool that breaks these rules,
 * this test fails before the model ever sees it.
 */
describe("tool registry", () => {
  it("has unique snake_case names", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(TOOLS_BY_NAME.size).toBe(TOOLS.length);
  });

  it.each(TOOLS.map((t) => [t.name, t] as const))(
    "%s has a useful description and a JSON Schema the model can read",
    (_name, tool) => {
      expect(tool.description.length).toBeGreaterThan(40);

      const schema = z.toJSONSchema(tool.inputSchema, { io: "input" }) as {
        type?: string;
        properties?: Record<string, { description?: string }>;
      };
      expect(schema.type).toBe("object");
      // Every input field must explain itself: the model only sees names and descriptions.
      for (const [field, property] of Object.entries(schema.properties ?? {})) {
        expect(property.description, `${tool.name}.${field} needs .describe()`).toBeTruthy();
      }
    },
  );
});
