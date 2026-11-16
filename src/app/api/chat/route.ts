import { ZodError } from "zod";
import { DATABASE_NOT_READY_MESSAGE, isDatabaseNotReady, sendBuyerMessage } from "@/agent";

/**
 * POST /api/chat  { leadId?: uuid, message: string }  →  ChatResponse
 *
 * 400 bad input · 503 database not set up · 500 anything else (logged).
 * Model problems never reach here: the agent turns them into a safe reply (200).
 */
/** A message is at most 2,000 characters; anything far bigger is refused before parsing. */
const MAX_BODY_CHARS = 16_000;

export async function POST(request: Request): Promise<Response> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_CHARS) return tooLarge();
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return tooLarge();

  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "The request body must be JSON." }, { status: 400 });
  }

  try {
    return Response.json(await sendBuyerMessage(body));
  } catch (error) {
    if (error instanceof ZodError) {
      const message = error.issues.map((issue) => issue.message).join(" ");
      return Response.json({ error: message }, { status: 400 });
    }
    if (isDatabaseNotReady(error)) {
      return Response.json({ error: DATABASE_NOT_READY_MESSAGE }, { status: 503 });
    }
    console.error("[api/chat]", error);
    return Response.json({ error: "Something went wrong. Please try again." }, { status: 500 });
  }
}

function tooLarge(): Response {
  return Response.json({ error: "The request is too large." }, { status: 413 });
}
