import { and, asc, count, eq, like, lte, type SQL } from "drizzle-orm";
import { z } from "zod";
import { LISTING_STATUSES, PROPERTY_TYPES, PURPOSES, listings } from "@/db/schema";
import { defineTool } from "@/tools/types";

const MAX_RESULTS = 5;

/** Common short names buyers use → the area name stored in the database. */
export const AREA_ALIASES: Readonly<Record<string, string>> = {
  jvc: "Jumeirah Village Circle",
  jlt: "Jumeirah Lake Towers",
  // Models write "Lakes" (eval traces 2026-11-21: 5 searches, 0 results).
  "jumeirah lakes towers": "Jumeirah Lake Towers",
  "jumeirah lakes tower": "Jumeirah Lake Towers",
  "the palm": "Palm Jumeirah",
  downtown: "Downtown Dubai",
  marina: "Dubai Marina",
  "dubai hills": "Dubai Hills Estate",
};

/**
 * "Jumeirah Lakes Towers (JLT)" → "Jumeirah Lake Towers": drop a note in brackets, then map aliases. A name that is
 * only a bracket uses what's inside ("(JLT)" → "JLT"), and never becomes "" (LIKE '%%' would match every listing).
 */
export function normalizeArea(area: string): string {
  const outside = area.replace(/\s*\([^)]*\)\s*/g, " ").trim();
  const inside = area.replace(/[()]/g, " ").trim();
  const name = outside || inside || area.trim();
  return AREA_ALIASES[name.toLowerCase()] ?? name;
}

const inputSchema = z.object({
  purpose: z
    .enum(PURPOSES)
    .optional()
    .describe("'rent' (yearly rent) or 'sale' (buying). Leave out only if the buyer hasn't said."),
  area: z
    .string()
    .min(2)
    .max(60)
    .optional()
    .describe("Area or community, e.g. 'Dubai Marina', 'JVC', 'Downtown'. Partial names work."),
  beds: z.coerce
    .number()
    .int()
    .min(0)
    .max(10)
    .optional()
    .describe("Exact number of bedrooms. 0 = studio."),
  maxPriceAed: z.coerce
    .number()
    .int()
    .positive()
    .optional()
    .describe("Maximum price in AED: yearly rent for rentals, total price for sales."),
  propertyType: z.enum(PROPERTY_TYPES).optional().describe("apartment, villa or townhouse."),
  status: z
    .enum(LISTING_STATUSES)
    .optional()
    .describe("'ready' = can move in now, 'off_plan' = still being built."),
});

type SearchInput = z.output<typeof inputSchema>;

function buildFilters(input: SearchInput, { withPriceLimit }: { withPriceLimit: boolean }) {
  const filters: SQL[] = [];
  if (input.purpose) filters.push(eq(listings.purpose, input.purpose));
  if (input.area) filters.push(like(listings.area, `%${normalizeArea(input.area)}%`));
  if (input.beds !== undefined) filters.push(eq(listings.beds, input.beds));
  if (input.propertyType) filters.push(eq(listings.propertyType, input.propertyType));
  if (input.status) filters.push(eq(listings.status, input.status));
  if (withPriceLimit && input.maxPriceAed !== undefined) {
    filters.push(lte(listings.priceAed, input.maxPriceAed));
  }
  return and(...filters);
}

export const searchListings = defineTool({
  name: "search_listings",
  description:
    "Search the agency's listings. Use it whenever the buyer describes what they want, before suggesting any " +
    "property. Returns at most 5 matches, cheapest first. Never mention a property or price that this tool " +
    "(or get_listing) did not return.",
  inputSchema,
  async run(input, { db }) {
    const where = buildFilters(input, { withPriceLimit: true });
    const [rows, totals] = await Promise.all([
      db
        .select({
          id: listings.id,
          title: listings.title,
          area: listings.area,
          propertyType: listings.propertyType,
          beds: listings.beds,
          purpose: listings.purpose,
          priceAed: listings.priceAed,
          status: listings.status,
        })
        .from(listings)
        .where(where)
        .orderBy(asc(listings.priceAed), asc(listings.id))
        .limit(MAX_RESULTS),
      db.select({ total: count() }).from(listings).where(where),
    ]);
    const total = totals[0]?.total ?? 0;

    if (total > 0) {
      return {
        ok: true as const,
        total,
        listings: rows,
        message:
          total > rows.length
            ? `Showing the ${rows.length} cheapest of ${total} matches.`
            : `${total} match(es).`,
      };
    }

    // Nothing found: always give the model a next step. If the budget is the only problem, say so.
    let hint = "Ask the buyer which filter (area, bedrooms, type) they can be flexible on.";
    if (input.maxPriceAed !== undefined) {
      const [withoutLimit] = await db
        .select({ total: count() })
        .from(listings)
        .where(buildFilters(input, { withPriceLimit: false }));
      if (withoutLimit && withoutLimit.total > 0) {
        hint = `${withoutLimit.total} listing(s) match if the price limit is removed — ask the buyer if the budget is flexible.`;
      }
    }
    return {
      ok: true as const,
      total: 0,
      listings: [],
      message: `No listings match these filters. ${hint}`,
    };
  },
});
