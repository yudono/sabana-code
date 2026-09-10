// ─── Mock LLM provider for benchmarks ───
// Deterministic: replays a per-task tool-call script, then answers final.
// Lets the benchmark harness run end-to-end with no LLM key/cost,
// following the same pattern as real providers (tool_call → finish events).
import type { LLMProvider } from "./provider.js";
import type { ModelEvent, ModelRequest } from "./types.js";

export interface MockStep {
  name: string;
  args: Record<string, unknown>;
}

let plan: MockStep[] = [];
let consumed = false;

/** Filled by the harness before each task. Tasks run sequentially, so this is safe. */
export function setMockPlan(p: MockStep[]): void {
  plan = p;
  consumed = false;
}

export class MockProvider implements LLMProvider {
  readonly name: string = "mock";

  async *generate(_req: ModelRequest): AsyncIterable<ModelEvent> {
    if (!consumed) {
      consumed = true;
      for (let i = 0; i < plan.length; i++) {
        yield { type: "tool_call", id: `mock-${i}`, name: plan[i].name, args: plan[i].args };
      }
      yield { type: "finish", stop_reason: "tool_calls" };
    } else {
      yield { type: "text_delta", text: "Mock task complete." };
      yield { type: "finish", stop_reason: "stop" };
    }
  }
}
