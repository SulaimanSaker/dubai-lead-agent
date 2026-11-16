import type { LeadView } from "@/agent";

export function formatAed(value: number | null | undefined): string {
  return value === null || value === undefined ? "—" : `AED ${value.toLocaleString("en-US")}`;
}

const DUBAI_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Dubai",
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** An ISO timestamp shown in Dubai time, e.g. "Mon 16 Nov, 14:05". */
export function formatDubaiTime(iso: string): string {
  return DUBAI_TIME.format(new Date(iso));
}

export const FIELD_LABELS: Record<keyof LeadView["fields"], string> = {
  purpose: "Purpose",
  areas: "Areas",
  beds: "Bedrooms",
  budgetAed: "Budget",
  timeline: "Timeline",
  financing: "Financing",
};

const TIMELINE: Record<string, string> = {
  asap: "As soon as possible",
  "1_3_months": "1–3 months",
  "3_6_months": "3–6 months",
  "6_plus_months": "6+ months",
  browsing: "Just browsing",
};

/** A lead field as readable text; "—" when unknown. */
export function formatField(field: keyof LeadView["fields"], fields: LeadView["fields"]): string {
  switch (field) {
    case "purpose":
      return fields.purpose === "sale" ? "Buy" : fields.purpose === "rent" ? "Rent" : "—";
    case "areas":
      return fields.areas?.length ? fields.areas.join(", ") : "—";
    case "beds":
      return fields.beds === null ? "—" : fields.beds === 0 ? "Studio" : String(fields.beds);
    case "budgetAed":
      return fields.budgetAed === null
        ? "—"
        : `${formatAed(fields.budgetAed)}${fields.purpose === "rent" ? " / year" : ""}`;
    case "timeline":
      return fields.timeline ? (TIMELINE[fields.timeline] ?? fields.timeline) : "—";
    case "financing":
      return fields.financing === "cash"
        ? "Cash"
        : fields.financing === "mortgage"
          ? "Mortgage"
          : "—";
  }
}

export const STATUS_LABELS: Record<LeadView["status"], string> = {
  new: "New",
  qualified: "Qualified",
  viewing_booked: "Viewing booked",
  handed_off: "Handed off",
};
