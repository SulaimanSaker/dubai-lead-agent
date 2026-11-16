import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getLeads } from "@/agent";
import { ScoreBadge, StatusBadge } from "@/app/components/badges";
import { DatabaseNotice } from "@/app/components/database-notice";
import { FIELD_LABELS, formatDubaiTime } from "@/app/lib/format";
import { loadPageData } from "@/app/lib/load";

export const metadata: Metadata = { title: "Leads · Dubai Lead Agent" };

export default function LeadsPage() {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 p-4 lg:p-8">
      <div className="mb-6 flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-2xl font-semibold text-zinc-900">Leads</h1>
        <Link
          href="/chat"
          className="rounded-full bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800"
        >
          New buyer chat
        </Link>
      </div>
      <Suspense fallback={<p className="text-sm text-zinc-500">Loading leads…</p>}>
        <LeadsTable />
      </Suspense>
    </main>
  );
}

async function LeadsTable() {
  await connection();
  const loaded = await loadPageData(getLeads);
  if (!loaded.ready) return <DatabaseNotice />;
  const leads = loaded.data;

  if (leads.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500">
        No leads yet. Start a buyer chat and the lead appears here.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white shadow-sm">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-zinc-200 bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="px-4 py-3 font-medium">Summary</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Score</th>
            <th className="px-4 py-3 font-medium">Still unknown</th>
            <th className="px-4 py-3 font-medium">Last activity</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {leads.map((lead) => (
            <tr key={lead.id} className="align-top hover:bg-zinc-50">
              <td className="max-w-md px-4 py-3">
                <Link
                  href={`/leads/${lead.id}`}
                  className="font-medium text-zinc-900 hover:underline"
                >
                  {lead.summary}
                </Link>
                <p className="mt-0.5 font-mono text-xs text-zinc-400">{lead.id.slice(0, 8)}</p>
              </td>
              <td className="px-4 py-3">
                <StatusBadge status={lead.status} />
              </td>
              <td className="px-4 py-3">
                <ScoreBadge score={lead.score} />
              </td>
              <td className="px-4 py-3 text-zinc-600">
                {lead.missing.length === 0
                  ? "—"
                  : lead.missing
                      .map((field) => FIELD_LABELS[field as keyof typeof FIELD_LABELS] ?? field)
                      .join(", ")}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-zinc-600">
                {formatDubaiTime(lead.updatedAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
