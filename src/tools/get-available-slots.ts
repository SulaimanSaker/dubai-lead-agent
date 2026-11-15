import { and, eq, gte, lt } from "drizzle-orm";
import { z } from "zod";
import { viewings } from "@/db/schema";
import {
  MAX_DAYS_AHEAD,
  addDays,
  dubaiParts,
  formatSlot,
  lastBookableDate,
  slotStartsOn,
  whyNotBookable,
} from "@/tools/lib/calendar";
import { defineTool } from "@/tools/types";

const MAX_SLOTS = 24;

export const getAvailableSlots = defineTool({
  name: "get_available_slots",
  description:
    "List free viewing times (1 hour each, Dubai time). Use it before booking, then offer the buyer 2–3 options. " +
    `The agent works Monday–Saturday, 10:00–18:00, and books up to ${MAX_DAYS_AHEAD} days ahead.`,
  inputSchema: z.object({
    fromDate: z.iso
      .date()
      .optional()
      .describe("First day to check, YYYY-MM-DD in Dubai time. Leave out to start today."),
    days: z.coerce
      .number()
      .int()
      .min(1)
      .max(7)
      .default(3)
      .describe("How many days to check (1–7). Default 3."),
  }),
  async run({ fromDate, days }, { db, now }) {
    const today = dubaiParts(now).date;
    const lastDate = lastBookableDate(now);
    const firstDay = fromDate && fromDate > today ? fromDate : today;

    if (firstDay > lastDate) {
      return {
        ok: true as const,
        timezone: "Asia/Dubai (UTC+4)",
        checked: null,
        slots: [],
        truncated: false,
        message: `Viewings can be booked at most ${MAX_DAYS_AHEAD} days ahead (until ${lastDate}). Ask for an earlier date.`,
      };
    }

    const dates = Array.from({ length: days }, (_, i) => addDays(firstDay, i)).filter(
      (date) => date <= lastDate,
    );

    // Booked viewings in the whole range, in one query.
    const rangeStart = new Date(`${firstDay}T00:00:00+04:00`).toISOString();
    const rangeEnd = new Date(
      `${addDays(dates.at(-1) ?? firstDay, 1)}T00:00:00+04:00`,
    ).toISOString();
    const booked = await db
      .select({ startsAt: viewings.startsAt })
      .from(viewings)
      .where(
        and(
          eq(viewings.status, "booked"),
          gte(viewings.startsAt, rangeStart),
          lt(viewings.startsAt, rangeEnd),
        ),
      );
    const taken = new Set(booked.map((v) => v.startsAt));

    const allFree = dates
      .flatMap(slotStartsOn)
      .filter((start) => whyNotBookable(start, now) === null && !taken.has(start.toISOString()));
    const truncated = allFree.length > MAX_SLOTS;
    const shown = allFree.slice(0, MAX_SLOTS);

    // Only claim the days we actually report on. If the list was cut, the last reported day is the day of
    // the last slot shown — otherwise the model would wrongly tell the buyer later days are fully booked.
    const lastShown = shown.at(-1);
    const checkedTo = truncated && lastShown ? dubaiParts(lastShown).date : dates.at(-1);

    let message: string;
    if (shown.length === 0) message = "No free slots in this range. Try later dates.";
    else if (truncated)
      message = `Showing the first ${MAX_SLOTS} free slots (up to ${checkedTo}). Later days were not checked — call again with fromDate if the buyer wants later times. Offer 2–3 options.`;
    else message = `${shown.length} free slot(s). Offer the buyer 2–3 of them.`;

    return {
      ok: true as const,
      timezone: "Asia/Dubai (UTC+4)",
      checked: { from: firstDay, to: checkedTo },
      slots: shown.map(formatSlot),
      truncated,
      message,
    };
  },
});
