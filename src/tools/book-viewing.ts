import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { leads, listings, viewings } from "@/db/schema";
import { formatSlot, whyNotBookable } from "@/tools/lib/calendar";
import { ensureLead } from "@/tools/lib/leads";
import { defineTool } from "@/tools/types";

/** SQLite's "UNIQUE constraint failed", possibly wrapped by Drizzle in `cause`. */
function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (e.message.includes("UNIQUE constraint failed")) return true;
  }
  return false;
}

const slotTaken = (label: string) => ({
  ok: false as const,
  error: "conflict" as const,
  message: `${label} is already booked. Call get_available_slots and offer other times.`,
});

export const bookViewing = defineTool({
  name: "book_viewing",
  description:
    "Book a viewing of one listing at a free time. Only use a time from get_available_slots, and only after the " +
    "buyer has agreed to that time. Confirm the booking to the buyer using the returned label.",
  inputSchema: z.object({
    listingId: z.string().trim().min(1).max(20).describe("Listing id, e.g. 'L02'."),
    startsAt: z.iso
      .datetime({ offset: true })
      .describe(
        "Start time exactly as returned by get_available_slots, e.g. '2026-11-17T10:00:00+04:00'.",
      ),
  }),
  async run({ listingId, startsAt }, ctx) {
    const { db, now } = ctx;
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

    const lead = await ensureLead(ctx);
    if (lead.status === "handed_off") {
      return {
        ok: false as const,
        error: "not_allowed" as const,
        message:
          "This buyer was handed to a human agent. Don't book; the human agent will arrange viewings.",
      };
    }

    const start = new Date(startsAt);
    const reason = whyNotBookable(start, now);
    const { label, startsAt: dubaiStartsAt } = formatSlot(start);
    if (reason) {
      return {
        ok: false as const,
        error: "not_allowed" as const,
        message: `Can't book ${label}: ${reason} Call get_available_slots for valid times.`,
      };
    }

    const startUtc = start.toISOString();
    const existing = await db.query.viewings.findFirst({
      where: and(eq(viewings.startsAt, startUtc), eq(viewings.status, "booked")),
    });
    if (existing) return slotTaken(label);

    const viewingId = crypto.randomUUID();
    try {
      // One atomic batch: the viewing and the lead status are saved together, or not at all.
      await db.batch([
        db.insert(viewings).values({
          id: viewingId,
          leadId: ctx.leadId,
          listingId: listing.id,
          startsAt: startUtc,
          createdAt: now.toISOString(),
        }),
        db
          .update(leads)
          .set({ status: "viewing_booked", updatedAt: now.toISOString() })
          .where(eq(leads.id, ctx.leadId)),
      ]);
    } catch (error) {
      // Another request booked the same slot between our check and our insert:
      // the unique index refused it.
      if (isUniqueViolation(error)) return slotTaken(label);
      throw error;
    }

    return {
      ok: true as const,
      viewingId,
      listing: { id: listing.id, title: listing.title, area: listing.area },
      startsAt: dubaiStartsAt,
      label,
      message: `Booked: ${listing.title}, ${label} (Dubai time). Confirm this to the buyer.`,
    };
  },
});
