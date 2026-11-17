/**
 * Next.js runs `register()` once when the server starts (see node_modules/next/dist/docs/01-app/02-guides/
 * instrumentation.md). We start Langfuse tracing here, in the Node.js runtime only.
 * Without LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY it logs "tracing off" and does nothing.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startTracing } = await import("@/agent/tracing");
    startTracing();
  }
}
