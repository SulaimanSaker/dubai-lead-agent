import Link from "next/link";
import type { LeadView } from "@/agent";
import { ScoreBadge, StatusBadge } from "@/app/components/badges";
import { FIELD_LABELS, formatField } from "@/app/lib/format";

const FIELDS = Object.keys(FIELD_LABELS) as (keyof LeadView["fields"])[];

/** The lead as the agent sees it: used live next to the chat and on the lead page. */
export function LeadCard({ lead, showLink = false }: { lead: LeadView; showLink?: boolean }) {
  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-sm font-semibold text-zinc-900">Lead</h2>
        <StatusBadge status={lead.status} />
        <ScoreBadge score={lead.score} />
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        {FIELDS.map((field) => {
          const missing = lead.missing.includes(field);
          return (
            <div key={field} className="contents">
              <dt className="text-zinc-500">{FIELD_LABELS[field]}</dt>
              <dd className={missing ? "text-zinc-400" : "font-medium text-zinc-900"}>
                {formatField(field, lead.fields)}
              </dd>
            </div>
          );
        })}
      </dl>
      <p className="mt-3 text-sm text-zinc-600">{lead.summary}</p>
      {lead.viewings.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm">
          {lead.viewings.map((viewing) => (
            <li key={`${viewing.listingId}-${viewing.label}`} className="text-emerald-800">
              Viewing: {viewing.title} ({viewing.listingId}), {viewing.label}
              {viewing.status !== "booked" && ` (${viewing.status})`}
            </li>
          ))}
        </ul>
      )}
      {showLink && (
        <Link
          href={`/leads/${lead.id}`}
          className="mt-3 inline-block text-sm font-medium text-teal-700 hover:underline"
        >
          Open in agent view →
        </Link>
      )}
    </section>
  );
}
