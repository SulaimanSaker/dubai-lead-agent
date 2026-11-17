import { isLangfuseSpan, LangfuseSpanProcessor } from "@langfuse/otel";
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";
import type { SpanExporter } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { readTracingConfig } from "@/agent/tracing/config";

interface TracingState {
  processor: LangfuseSpanProcessor;
  provider: NodeTracerProvider;
}

// Once per process. Kept on globalThis so Next.js hot reload doesn't register a second provider.
const globalForTracing = globalThis as typeof globalThis & { __tracing?: TracingState | null };

/**
 * Register OpenTelemetry with Langfuse's span processor, once. Does nothing without Langfuse keys.
 * Returns whether tracing is on. `exporter` replaces the network exporter (tests).
 */
export function startTracing(options: { exporter?: SpanExporter; log?: boolean } = {}): boolean {
  if (globalForTracing.__tracing !== undefined) return globalForTracing.__tracing !== null;

  const config = options.exporter
    ? { enabled: true as const, publicKey: "pk-lf-test", secretKey: "sk-lf-test", baseUrl: "" }
    : readTracingConfig();
  if (!config.enabled) {
    globalForTracing.__tracing = null;
    if (options.log !== false) console.info(`[tracing] off (${config.reason})`);
    return false;
  }

  const processor = new LangfuseSpanProcessor({
    publicKey: config.publicKey,
    secretKey: config.secretKey,
    ...(config.baseUrl && { baseUrl: config.baseUrl }),
    ...(options.exporter && { exporter: options.exporter }),
    environment: process.env.NODE_ENV === "production" ? "production" : "development",
    // Only our own spans. The default also exports other libraries' GenAI spans: the Anthropic SDK makes an
    // "anthropic.messages.create" span for every call, which doubled every model call, token and cost.
    shouldExportSpan: ({ otelSpan }) => isLangfuseSpan(otelSpan),
  });
  const provider = new NodeTracerProvider({ spanProcessors: [processor] });
  provider.register();
  // Export problems (wrong keys → 401, no network) are logged by OpenTelemetry's own logger, which is silent
  // by default: traces would just vanish. Show warnings and errors.
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.WARN);
  globalForTracing.__tracing = { processor, provider };
  if (options.log !== false && !options.exporter) {
    console.info(`[tracing] on → ${config.baseUrl}`);
  }
  return true;
}

export function isTracingOn(): boolean {
  return Boolean(globalForTracing.__tracing);
}

/** Send buffered spans now. Scripts must call this before exiting, or the last traces are lost. */
export async function flushTracing(): Promise<void> {
  await globalForTracing.__tracing?.processor.forceFlush();
}

/**
 * Flush and stop (scripts, tests). OpenTelemetry registers its global provider once per process, so tracing
 * can't be started again in the same process after this.
 */
export async function stopTracing(): Promise<void> {
  const state = globalForTracing.__tracing;
  globalForTracing.__tracing = undefined;
  if (!state) return;
  await state.processor.forceFlush();
  await state.provider.shutdown();
}
