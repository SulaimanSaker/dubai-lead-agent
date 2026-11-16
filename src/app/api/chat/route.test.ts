import { afterEach, describe, expect, it, vi } from "vitest";
import type * as Agent from "@/agent";
import { POST } from "@/app/api/chat/route";

// The route's own logic is tested here with the agent replaced: request parsing and error mapping.
// The agent itself is covered by src/agent/*.test.ts.
const sendBuyerMessage = vi.hoisted(() => vi.fn());
vi.mock("@/agent", async (importOriginal) => ({
  ...(await importOriginal<typeof Agent>()),
  sendBuyerMessage,
}));

function post(body: string) {
  return POST(new Request("http://localhost/api/chat", { method: "POST", body }));
}

afterEach(() => {
  vi.restoreAllMocks();
  sendBuyerMessage.mockReset();
});

describe("POST /api/chat", () => {
  it("returns the agent's response", async () => {
    sendBuyerMessage.mockResolvedValue({ leadId: "x", reply: "Hello!" });
    const response = await post(JSON.stringify({ message: "Hi" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ leadId: "x", reply: "Hello!" });
    expect(sendBuyerMessage).toHaveBeenCalledWith({ message: "Hi" });
  });

  it("refuses a huge body by its declared size, before reading it", async () => {
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      body: "{}",
      headers: { "content-length": "999999" },
    });
    expect((await POST(request)).status).toBe(413);
    expect(sendBuyerMessage).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    const response = await post("not json");
    expect(response.status).toBe(400);
    expect(sendBuyerMessage).not.toHaveBeenCalled();
  });

  it("turns validation errors into a 400 with readable messages (real schema)", async () => {
    const { buyerMessageSchema } = await import("@/agent");
    sendBuyerMessage.mockImplementation(async (input: unknown) => buyerMessageSchema.parse(input));
    const empty = await post(JSON.stringify({ message: "  " }));
    expect(empty.status).toBe(400);
    expect(await empty.json()).toEqual({ error: "Message is empty." });

    const badId = await post(JSON.stringify({ leadId: "lead-1", message: "Hi" }));
    expect(badId.status).toBe(400);
  });

  it("rejects a message that is too long (real schema) and a body that is far too large", async () => {
    const { buyerMessageSchema } = await import("@/agent");
    sendBuyerMessage.mockImplementation(async (input: unknown) => buyerMessageSchema.parse(input));
    const long = await post(JSON.stringify({ message: "x".repeat(2001) }));
    expect(long.status).toBe(400);
    expect(await long.json()).toEqual({ error: "Message is too long." });

    const huge = await post(JSON.stringify({ message: "x".repeat(20_000) }));
    expect(huge.status).toBe(413);
  });

  it("says how to fix a missing database (503)", async () => {
    sendBuyerMessage.mockRejectedValue(
      new Error("Failed query", { cause: new Error("SQLITE_ERROR: no such table: leads") }),
    );
    const response = await post(JSON.stringify({ message: "Hi" }));
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/npm run db:seed/);
  });

  it("hides unexpected errors behind a 500 and logs them", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    sendBuyerMessage.mockRejectedValue(new Error("disk full at /var/secret/path"));
    const response = await post(JSON.stringify({ message: "Hi" }));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("secret");
    expect(log).toHaveBeenCalled();
  });
});
