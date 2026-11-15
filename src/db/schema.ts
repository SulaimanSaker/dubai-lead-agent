import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const PURPOSES = ["rent", "sale"] as const;
export const PROPERTY_TYPES = ["apartment", "villa", "townhouse"] as const;
export const LISTING_STATUSES = ["ready", "off_plan"] as const;
export const TIMELINES = ["asap", "1_3_months", "3_6_months", "6_plus_months", "browsing"] as const;
export const FINANCING = ["cash", "mortgage"] as const;
export const LEAD_STATUSES = ["new", "qualified", "viewing_booked", "handed_off"] as const;
export const HANDOFF_REASONS = ["negotiation", "complaint", "asked_for_human", "other"] as const;
export const VIEWING_STATUSES = ["booked", "cancelled"] as const;

export const listings = sqliteTable(
  "listings",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    area: text("area").notNull(),
    propertyType: text("property_type", { enum: PROPERTY_TYPES }).notNull(),
    /** 0 = studio */
    beds: integer("beds").notNull(),
    baths: integer("baths").notNull(),
    sizeSqft: integer("size_sqft").notNull(),
    purpose: text("purpose", { enum: PURPOSES }).notNull(),
    /** Yearly rent for `rent`, full price for `sale`. Always AED. */
    priceAed: integer("price_aed").notNull(),
    status: text("status", { enum: LISTING_STATUSES }).notNull(),
    /** Expected handover month for off-plan, e.g. "2028-06". */
    handoverDate: text("handover_date"),
    furnished: integer("furnished", { mode: "boolean" }).notNull(),
    features: text("features", { mode: "json" }).$type<string[]>().notNull(),
    description: text("description").notNull(),
  },
  (t) => [index("listings_search_idx").on(t.purpose, t.area, t.beds, t.priceAed)],
);

export const leads = sqliteTable("leads", {
  id: text("id").primaryKey(),
  purpose: text("purpose", { enum: PURPOSES }),
  areas: text("areas", { mode: "json" }).$type<string[]>(),
  beds: integer("beds"),
  budgetAed: integer("budget_aed"),
  timeline: text("timeline", { enum: TIMELINES }),
  financing: text("financing", { enum: FINANCING }),
  status: text("status", { enum: LEAD_STATUSES }).notNull().default("new"),
  handoffReason: text("handoff_reason", { enum: HANDOFF_REASONS }),
  handoffSummary: text("handoff_summary"),
  /** ISO 8601, UTC */
  createdAt: text("created_at").notNull(),
  /** ISO 8601, UTC */
  updatedAt: text("updated_at").notNull(),
});

export const viewings = sqliteTable(
  "viewings",
  {
    id: text("id").primaryKey(),
    leadId: text("lead_id")
      .notNull()
      .references(() => leads.id),
    listingId: text("listing_id")
      .notNull()
      .references(() => listings.id),
    /** ISO 8601, UTC, always on the hour */
    startsAt: text("starts_at").notNull(),
    status: text("status", { enum: VIEWING_STATUSES }).notNull().default("booked"),
    createdAt: text("created_at").notNull(),
  },
  // One agent, one calendar: the database itself refuses two booked viewings at the same time,
  // even if two requests race past the application check.
  (t) => [
    uniqueIndex("viewings_one_booking_per_slot")
      .on(t.startsAt)
      .where(sql`${t.status} = 'booked'`),
  ],
);

export type Listing = typeof listings.$inferSelect;
export type Lead = typeof leads.$inferSelect;
export type Viewing = typeof viewings.$inferSelect;
