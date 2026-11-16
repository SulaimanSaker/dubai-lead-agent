import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { getLead } from "@/agent";
import { DatabaseNotice } from "@/app/components/database-notice";
import { LeadCard } from "@/app/components/lead-card";
import { RichText } from "@/app/components/rich-text";
import { formatDubaiTime } from "@/app/lib/format";
import { loadPageData } from "@/app/lib/load";

export const metadata: Metadata = { title: "Lead · Dubai Lead Agent" };

export default function LeadPage({ params }: PageProps<"/leads/[id]">) {
  return (
    <main className="mx-auto w-full max-w-6xl flex-1 p-4 lg:p-8">
      <Link href="/leads" className="text-sm text-teal-700 hover:underline">
        ← All leads
      </Link>
      <Suspense fallback={<p className="mt-6 text-sm text-zinc-500">Loading lead…</p>}>
        <LeadDetailView params={params} />
      </Suspense>
    </main>
  );
}

const number = (value: unknown) =>
  typeof value === "number" ? value.toLocaleString("en-US") : "—";

async function LeadDetailView({ params }: Pick<PageProps<"/leads/[id]">, "params">) {
  await connection();
  const { id } = await params;
  const loaded = await loadPageData(() => getLead(id));
  if (!loaded.ready) return <DatabaseNotice />;
  const lead = loaded.data;
  if (!lead) notFound();

  return (
    <div className="mt-4 grid gap-6 lg:grid-cols-[20rem_1fr]">
      <div className="space-y-4">
        <LeadCard lead={lead} />
        {lead.handoff && (
          <section className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <h2 className="mb-1 font-semibold">Needs a human agent</h2>
            <p className="mb-1">Reason: {lead.handoff.reason?.replaceAll("_", " ") ?? "other"}</p>
            <p>{lead.handoff.summary}</p>
          </section>
        )}
        <Link
          href={`/chat?lead=${lead.id}`}
          className="inline-block rounded-full bg-teal-700 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-800"
        >
          Open this chat
        </Link>
      </div>

      <div className="min-w-0 space-y-6">
        <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="mb-3 text-sm font-semibold text-zinc-900">Conversation</h2>
          {lead.transcript.length === 0 ? (
            <p className="text-sm text-zinc-500">No messages yet.</p>
          ) : (
            <ol className="space-y-3">
              {lead.transcript.map((entry, index) => (
                <li key={index} className={entry.role === "buyer" ? "pl-0 sm:pr-16" : "sm:pl-16"}>
                  <p className="mb-0.5 text-xs font-medium text-zinc-500">
                    {entry.role === "buyer" ? "Buyer" : "Assistant"}
                    {entry.toolsUsed.length > 0 && (
                      <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
                        {entry.toolsUsed.map((tool, toolIndex) => (
                          <code
                            key={toolIndex}
                            className="rounded bg-zinc-100 px-1.5 py-0.5 text-[11px] text-zinc-600"
                          >
                            {tool}
                          </code>
                        ))}
                      </span>
                    )}
                  </p>
                  <div
                    dir="auto"
                    className={`rounded-lg px-3 py-2 text-sm text-zinc-900 ${
                      entry.role === "buyer" ? "bg-[#d9fdd3]" : "bg-zinc-100"
                    }`}
                  >
                    <RichText text={entry.text} />
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>

        <section className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
          <h2 className="mb-1 text-sm font-semibold text-zinc-900">Model turns</h2>
          <p className="mb-3 text-xs text-zinc-500">
            One row per buyer message: which model answered, with which prompt, and what it cost in
            tokens and time.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs tabular-nums">
              <thead className="text-zinc-500">
                <tr>
                  <th className="py-1 pr-3 font-medium">Time (Dubai)</th>
                  <th className="py-1 pr-3 font-medium">Model</th>
                  <th className="py-1 pr-3 font-medium">Prompt</th>
                  <th className="py-1 pr-3 font-medium">Input (cached)</th>
                  <th className="py-1 pr-3 font-medium">Output</th>
                  <th className="py-1 pr-3 font-medium">Latency</th>
                  <th className="py-1 font-medium">Outcome</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 text-zinc-700">
                {lead.turns.map(({ createdAt, meta }, index) => (
                  <tr key={index}>
                    <td className="whitespace-nowrap py-1.5 pr-3">{formatDubaiTime(createdAt)}</td>
                    <td className="py-1.5 pr-3">{String(meta.model ?? "—")}</td>
                    <td className="py-1.5 pr-3">{String(meta.promptVersion ?? "—")}</td>
                    <td className="py-1.5 pr-3">
                      {number(meta.inputTokens)} ({number(meta.cachedInputTokens)})
                    </td>
                    <td className="py-1.5 pr-3">{number(meta.outputTokens)}</td>
                    <td className="py-1.5 pr-3">
                      {typeof meta.latencyMs === "number"
                        ? `${(meta.latencyMs / 1000).toFixed(1)} s`
                        : "—"}
                    </td>
                    <td
                      className={`py-1.5 ${meta.outcome === "replied" ? "text-zinc-700" : "font-medium text-rose-700"}`}
                    >
                      {String(meta.outcome ?? "—")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}
