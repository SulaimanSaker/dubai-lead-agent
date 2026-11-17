import type { TurnObserver } from "@/agent/observer";
import { langfuseObserver } from "@/agent/tracing/langfuse";

export { flushTracing, isTracingOn, startTracing, stopTracing } from "@/agent/tracing/setup";

/** The observer the app uses: Langfuse (it runs turns untraced when tracing isn't started). */
export function getTurnObserver(): TurnObserver {
  return langfuseObserver;
}
