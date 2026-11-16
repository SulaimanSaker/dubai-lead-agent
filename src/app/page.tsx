import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { getModelInfo } from "@/agent";

/** Read at request time: the page is otherwise static, and env would be frozen at build time. */
async function ModelLabel() {
  await connection();
  const model = getModelInfo();
  return (
    <>
      {model.provider} · {model.model}
    </>
  );
}

export default function Home() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-8 p-6">
      <div>
        <p className="text-sm font-medium text-teal-700">Demo · fictional Dubai agency</p>
        <h1 className="mt-1 text-3xl font-semibold tracking-tight text-zinc-900">
          AI lead qualification agent
        </h1>
        <p className="mt-3 max-w-xl text-zinc-600">
          A buyer chats with an AI assistant that saves their requirements, searches listings, books
          viewings and hands off to a human agent when it should. The agent view shows each lead
          with its score, summary and the full conversation.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Link
          href="/chat"
          className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-teal-600"
        >
          <h2 className="font-semibold text-zinc-900">Buyer chat →</h2>
          <p className="mt-1 text-sm text-zinc-600">Talk to the assistant like a buyer would.</p>
        </Link>
        <Link
          href="/leads"
          className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm transition hover:border-teal-600"
        >
          <h2 className="font-semibold text-zinc-900">Agent view →</h2>
          <p className="mt-1 text-sm text-zinc-600">See every lead, its score and transcript.</p>
        </Link>
      </div>
      <p className="text-xs text-zinc-500">
        Model:{" "}
        <Suspense fallback="…">
          <ModelLabel />
        </Suspense>
        . Listings, prices and the agency are made up.
      </p>
    </main>
  );
}
