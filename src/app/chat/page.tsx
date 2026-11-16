import type { Metadata } from "next";
import { connection } from "next/server";
import { Suspense } from "react";
import { getChat, getModelInfo } from "@/agent";
import { ChatWindow } from "@/app/chat/chat-window";
import { DatabaseNotice } from "@/app/components/database-notice";
import { loadPageData } from "@/app/lib/load";

export const metadata: Metadata = { title: "Chat · Dubai Lead Agent" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default function ChatPage({ searchParams }: PageProps<"/chat">) {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-zinc-500">Loading chat…</p>}>
      <ChatLoader searchParams={searchParams} />
    </Suspense>
  );
}

/** Reads `?lead=<id>` and loads that conversation, so a reload keeps the chat. */
async function ChatLoader({ searchParams }: Pick<PageProps<"/chat">, "searchParams">) {
  await connection();
  const { lead } = await searchParams;
  const leadId = typeof lead === "string" && UUID.test(lead) ? lead : null;

  const loaded = await loadPageData(() => (leadId ? getChat(leadId) : Promise.resolve(null)));
  if (!loaded.ready) return <DatabaseNotice />;

  // Only bubbles and the lead summary reach the browser (see getChat); agent-only data stays here.
  const chat = loaded.data;
  return (
    <ChatWindow
      key={chat?.lead.id ?? "new"}
      initialLeadId={chat?.lead.id ?? null}
      initialMessages={chat?.messages ?? []}
      initialLead={chat?.lead ?? null}
      model={getModelInfo()}
    />
  );
}
