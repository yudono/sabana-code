// ─── Context-window guard: estimate + trim to fit the model window ───
import type { ModelMessage } from "../llm/types.js";
import { estimateTokens, getContextWindow } from "../llm/models.js";

export interface ContextUsage {
  tokens: number;
  window: number;
  pct: number;
}

export function messageTokens(m: ModelMessage): number {
  let s = m.content || "";
  if (m.tool_calls) {
    for (const tc of m.tool_calls) s += tc.function.name + tc.function.arguments;
  }
  return estimateTokens(s);
}

export function contextUsage(messages: ModelMessage[], model: string, provider: string): ContextUsage {
  const window = getContextWindow(model, provider);
  const tokens = messages.reduce((n, m) => n + messageTokens(m), 0);
  return { tokens, window, pct: window > 0 ? (tokens / window) * 100 : 0 };
}

/**
 * Trim oldest history so the estimate stays <= window - reserve.
 * System message (index 0) dan user pertama selalu dipertahankan.
 */
export function ensureFits(
  messages: ModelMessage[],
  model: string,
  provider: string,
  reserve = 8_192,
): { messages: ModelMessage[]; trimmed: number; usage: ContextUsage } {
  const window = getContextWindow(model, provider);
  const budget = Math.max(4_096, window - reserve);
  let current = messages.reduce((n, m) => n + messageTokens(m), 0);
  if (current <= budget) {
    return { messages, trimmed: 0, usage: { tokens: current, window, pct: (current / window) * 100 } };
  }
  const head = messages.slice(0, 2);
  let tail = messages.slice(2);
  let trimmed = 0;
  // Buang pasangan pesan tertua dulu (tool result + assistant), pertahankan minimal 4 pesan akhir.
  while (tail.length > 4 && current > budget) {
    const drop = tail.length > 6 ? 2 : 1;
    for (let i = 0; i < drop; i++) {
      const m = tail.shift();
      if (m) {
        current -= messageTokens(m);
        trimmed++;
      }
    }
  }
  const out = [...head, ...tail];
  // Drop orphan tool results at the tail start (their tool_calls parent was trimmed) —
  // without this the API rejects the history (tool without tool_call).
  let orphans = 0;
  while (out.length > 2 && out[2].role === "tool") {
    const m = out.splice(2, 1)[0];
    current -= messageTokens(m);
    trimmed++;
    orphans++;
  }
  void orphans;
  return { messages: out, trimmed, usage: { tokens: current, window, pct: (current / window) * 100 } };
}
