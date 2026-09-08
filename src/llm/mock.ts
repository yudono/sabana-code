// ─── Mock LLM provider untuk benchmark ───
// Deterministik: memutar skrip tool-call per task, lalu menjawab final.
// Memungkinkan harness benchmark diuji end-to-end tanpa LLM key/biaya,
// dengan pola yang sama seperti provider asli (event tool_call → finish).
import type { LLMProvider } from "./provider.js";
import type { ModelEvent, ModelRequest } from "./types.js";

export interface MockStep {
  name: string;
  args: Record<string, unknown>;
}

let plan: MockStep[] = [];
let consumed = false;

/** Diisi harness sebelum setiap task. Task berjalan sekuensial sehingga aman. */
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
