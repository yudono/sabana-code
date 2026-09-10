// ─── Compact: summarize history into one message to fit context ───
// Used manually via /compact and automatically past 80% window.
import type { ModelMessage } from "../llm/types.js";

/** Auto-compact threshold (% of context window). */
export const AUTO_COMPACT_PCT = 80;

/** Number of trailing messages kept intact after the summary. */
export const COMPACT_KEEP_LAST = 6;

const COMPACT_INSTRUCTION = `You are a context summarizer for a coding agent. Summarize the conversation history below into a dense summary (max ~400 words, English).

Must cover:
1. User goal & latest status (done / pending, what is missing).
2. Key decisions (model, library, chosen approach and why).
3. Files created/modified + their key changes.
4. Errors/loops encountered + how they were handled (so they are not repeated).
5. Planned next steps.

Write ONLY the summary, no opening/closing pleasantries.`;

function clip(s: string, n: number): string {
  const t = (s || "").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/** Build the summary prompt from the transcript (clipped to keep the request itself light). */
export function buildCompactPrompt(messages: ModelMessage[]): string {
  const body = messages.filter((m) => m.role !== "system");
  const lines = body.map((m) => {
    const tools = m.tool_calls?.length ? ` [tools: ${m.tool_calls.map((t) => t.function.name).join(",")}]` : "";
    return `[${m.role}]${tools}\n${clip(m.content || "", 1200)}`;
  });
  return `${COMPACT_INSTRUCTION}\n\n--- HISTORY ---\n${lines.join("\n\n")}`.slice(0, 14_000);
}

export interface CompactApplied {
  messages: ModelMessage[];
  dropped: number;
}

/**
 * Apply the summary: system[0] + summary message + last N messages.
 * Prevents orphan tool results at the start (without this the API rejects history).
 */
export function applyCompactSummary(
  messages: ModelMessage[],
  summary: string,
  keepLast = COMPACT_KEEP_LAST,
): CompactApplied {
  const before = messages.length;
  const system = messages.length > 0 && messages[0].role === "system" ? [messages[0]] : [];
  const body = messages.length > 0 && messages[0].role === "system" ? messages.slice(1) : [...messages];
  const tail = body.slice(-keepLast);
  const out: ModelMessage[] = [
    ...system,
    {
      role: "user",
      content: `## PREVIOUS CONTEXT SUMMARY\n${summary.trim()}\n\nContinue the work from this summary.`,
    },
    ...tail,
  ];
  let dropped = before - out.length;
  while (out.length > system.length + 1 && out[system.length + 1]?.role === "tool") {
    out.splice(system.length + 1, 1);
    dropped++;
  }
  return { messages: out, dropped };
}
