"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import type { ChatResponse, LeadView } from "@/agent";
import { LeadCard } from "@/app/components/lead-card";
import { RichText } from "@/app/components/rich-text";

export interface ChatBubble {
  role: "buyer" | "agent";
  text: string;
}

interface Props {
  initialLeadId: string | null;
  initialMessages: ChatBubble[];
  initialLead: LeadView | null;
  model: { provider: string; model: string };
}

/** The response body, or null when it isn't JSON (e.g. an HTML error page from a proxy). */
async function readJson(response: Response): Promise<ChatResponse | { error: string } | null> {
  try {
    return (await response.json()) as ChatResponse | { error: string };
  } catch {
    return null;
  }
}

const SUGGESTIONS = [
  "Hi, I want to rent a 2 bed in Dubai Marina, budget around 120k a year, paying cash.",
  "Looking to buy a villa in Dubai Hills, up to 6M, with a mortgage.",
  "Can I speak to a real person?",
];

export function ChatWindow({ initialLeadId, initialMessages, initialLead, model }: Props) {
  const [leadId, setLeadId] = useState(initialLeadId);
  const [messages, setMessages] = useState<ChatBubble[]>(initialMessages);
  const [lead, setLead] = useState<LeadView | null>(initialLead);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  // The request in flight. A ref (not state) so a fast double click can't start two sends,
  // and so it can be cancelled on "New chat" or when the page is left.
  const inFlight = useRef<AbortController | null>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, pending]);

  // Leaving the page cancels a pending reply, so it can't change the URL of the next page.
  useEffect(() => () => inFlight.current?.abort(), []);

  async function send(text: string) {
    const message = text.trim();
    // One message at a time: the agent must answer before the next one goes out.
    if (!message || inFlight.current) return;
    const controller = new AbortController();
    inFlight.current = controller;
    setError(null);
    setPending(true);
    setInput("");
    setMessages((current) => [...current, { role: "buyer", text: message }]);

    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(leadId ? { leadId, message } : { message }),
        signal: controller.signal,
      });
      const data = await readJson(response);
      if (!response.ok || !data || "error" in data) {
        throw new Error(
          data && "error" in data ? data.error : `The server had a problem (${response.status}).`,
        );
      }
      setMessages((current) => [...current, { role: "agent", text: data.reply }]);
      setLead(data.lead);
      if (data.leadId !== leadId) {
        setLeadId(data.leadId);
        // Keep the conversation on reload, without a navigation.
        window.history.replaceState(null, "", `/chat?lead=${data.leadId}`);
      }
    } catch (caught) {
      if (controller.signal.aborted) return; // cancelled on purpose: nothing to show
      // Undo the optimistic bubble and give the text back, so nothing is lost.
      setMessages((current) => current.slice(0, -1));
      setInput(message);
      setError(caught instanceof Error ? caught.message : "Could not send the message.");
    } finally {
      if (inFlight.current === controller) {
        inFlight.current = null;
        setPending(false);
      }
    }
  }

  /** Start over in place. A link to /chat would keep this component (same page) and its old state. */
  function startNewChat() {
    inFlight.current?.abort();
    inFlight.current = null;
    setPending(false);
    setLeadId(null);
    setMessages([]);
    setLead(null);
    setInput("");
    setError(null);
    window.history.replaceState(null, "", "/chat");
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void send(input);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send(input);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-1 gap-6 p-4 lg:p-6">
      <div className="flex h-[calc(100dvh-2rem)] min-w-0 flex-1 flex-col overflow-hidden rounded-2xl border border-zinc-200 shadow-sm lg:h-[calc(100dvh-3rem)]">
        <header className="flex items-center gap-3 bg-teal-700 px-4 py-3 text-white">
          <div className="flex size-9 items-center justify-center rounded-full bg-white/20 text-sm font-semibold">
            DH
          </div>
          <div className="mr-auto leading-tight">
            <p className="font-semibold">Dubai Homes assistant</p>
            <p className="text-xs text-teal-100">{pending ? "typing…" : "online · demo"}</p>
          </div>
          <button
            type="button"
            onClick={startNewChat}
            className="rounded-md px-2 py-1 text-sm hover:bg-white/10"
          >
            New chat
          </button>
          <Link href="/leads" className="rounded-md px-2 py-1 text-sm hover:bg-white/10">
            Agent view
          </Link>
        </header>

        <div
          role="log"
          aria-live="polite"
          aria-label="Conversation"
          className="flex-1 space-y-2 overflow-y-auto bg-[#efeae2] px-3 py-4 sm:px-6"
        >
          {messages.length === 0 && (
            <div className="mx-auto max-w-md space-y-3 py-6 text-center">
              <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 shadow-sm">
                Demo chat with an AI assistant for a fictional Dubai agency. Listings and prices are
                made up.
              </p>
              <p className="text-sm text-zinc-600">Try one of these:</p>
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => void send(suggestion)}
                  className="block w-full rounded-lg bg-white px-3 py-2 text-left text-sm text-zinc-800 shadow-sm hover:bg-zinc-50"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          )}

          {messages.map((message, index) => (
            <div
              key={index}
              className={`flex ${message.role === "buyer" ? "justify-end" : "justify-start"}`}
            >
              <div
                dir="auto"
                className={`max-w-[85%] rounded-lg px-3 py-2 text-[15px] leading-snug text-zinc-900 shadow-sm sm:max-w-[70%] ${
                  message.role === "buyer"
                    ? "rounded-tr-none bg-[#d9fdd3]"
                    : "rounded-tl-none bg-white"
                }`}
              >
                <RichText text={message.text} />
              </div>
            </div>
          ))}

          {pending && (
            <div className="flex justify-start" aria-label="The assistant is typing">
              <div className="rounded-lg rounded-tl-none bg-white px-3 py-2 text-sm text-zinc-500 shadow-sm">
                <span className="inline-flex gap-1">
                  <span className="animate-bounce">•</span>
                  <span className="animate-bounce [animation-delay:150ms]">•</span>
                  <span className="animate-bounce [animation-delay:300ms]">•</span>
                </span>
              </div>
            </div>
          )}
          <div ref={bottom} />
        </div>

        {error && (
          <p role="alert" className="bg-rose-50 px-4 py-2 text-sm text-rose-800">
            {error}
          </p>
        )}

        <form onSubmit={onSubmit} className="flex items-end gap-2 bg-[#f0f2f5] px-3 py-3">
          <label htmlFor="message" className="sr-only">
            Message
          </label>
          <textarea
            id="message"
            dir="auto"
            rows={1}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Type a message (English or Arabic)"
            maxLength={2000}
            className="max-h-32 min-h-10 flex-1 resize-none rounded-lg border-0 bg-white px-3 py-2 text-[15px] text-zinc-900 shadow-sm outline-none focus:ring-2 focus:ring-teal-600"
          />
          <button
            type="submit"
            disabled={pending || input.trim() === ""}
            className="h-10 rounded-full bg-teal-700 px-4 text-sm font-semibold text-white disabled:opacity-40"
          >
            Send
          </button>
        </form>
        <p className="bg-[#f0f2f5] px-4 pb-2 text-[11px] text-zinc-500">
          Answered by {model.provider} · {model.model}
        </p>
      </div>

      <aside className="hidden w-80 shrink-0 space-y-3 lg:block">
        {lead ? (
          <LeadCard lead={lead} showLink />
        ) : (
          <p className="rounded-xl border border-dashed border-zinc-300 p-4 text-sm text-zinc-500">
            The lead appears here as the assistant saves what the buyer says.
          </p>
        )}
      </aside>
    </div>
  );
}
