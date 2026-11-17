import type { TurnInfo, TurnObserver, TurnTrace } from "@/agent/observer";

export type RecordedEvent =
  | { kind: "turn"; info: TurnInfo }
  | { kind: "model:start"; step: number; messages: number }
  | { kind: "model:end"; ok: boolean; stop?: string; costUsd?: number | null }
  | { kind: "tool:start"; name: string }
  | { kind: "tool:end"; name: string; ok: boolean }
  | { kind: "guard"; action: string; amounts: string[] }
  | { kind: "finish"; outcome: string; costUsd: number | null };

/** An observer that writes down what the agent reported, in order. For tests. */
export class RecordingObserver implements TurnObserver {
  readonly events: RecordedEvent[] = [];

  turn<T>(info: TurnInfo, work: (trace: TurnTrace) => Promise<T>): Promise<T> {
    this.events.push({ kind: "turn", info });
    const events = this.events;
    const trace: TurnTrace = {
      traceId: "trace-recorded",
      modelCall(call) {
        events.push({ kind: "model:start", step: call.step, messages: call.messages.length });
        return {
          end(outcome) {
            events.push(
              "error" in outcome
                ? { kind: "model:end", ok: false }
                : {
                    kind: "model:end",
                    ok: true,
                    stop: outcome.result.stop,
                    costUsd: outcome.costUsd,
                  },
            );
          },
        };
      },
      toolCall(call) {
        events.push({ kind: "tool:start", name: call.name });
        return {
          end(outcome) {
            events.push({ kind: "tool:end", name: call.name, ok: outcome.ok });
          },
        };
      },
      guard(info) {
        events.push({ kind: "guard", action: info.action, amounts: info.amounts });
      },
      finish(summary) {
        events.push({ kind: "finish", outcome: summary.outcome, costUsd: summary.costUsd });
      },
    };
    return work(trace);
  }

  kinds(): string[] {
    return this.events.map((event) => event.kind);
  }
}
