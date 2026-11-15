import { eq } from "drizzle-orm";
import { z } from "zod";
import { listings } from "@/db/schema";
import { defineTool } from "@/tools/types";

export const getListing = defineTool({
  name: "get_listing",
  description:
    "Get the full details of one listing: size, features, description, and for off-plan listings the handover " +
    "date and payment plan (if any — it is listed in features). Use it when the buyer asks about a specific " +
    "property you found with search_listings. Only state details that appear in the result.",
  inputSchema: z.object({
    listingId: z
      .string()
      .trim()
      .min(1)
      .max(20)
      .describe("The listing id from search_listings, e.g. 'L02'."),
  }),
  async run({ listingId }, { db }) {
    const listing = await db.query.listings.findFirst({
      where: eq(listings.id, listingId.toUpperCase()),
    });
    if (!listing) {
      return {
        ok: false as const,
        error: "not_found" as const,
        message: `No listing with id "${listingId}". Use search_listings to find valid ids.`,
      };
    }
    return { ok: true as const, listing };
  },
});
