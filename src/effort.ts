// ─── Effort presets: trade thinking budget vs speed, per session ───
// low = quick answers, medium = balanced default, high = deep work.
// Controls maxTokens + maxSteps for newly created agents of the session.

export type EffortLevel = "low" | "medium" | "high";

export interface EffortPreset {
  maxTokens: number;
  maxSteps: number;
  desc: string;
}

export const EFFORT_PRESETS: Record<EffortLevel, EffortPreset> = {
  low: { maxTokens: 2048, maxSteps: 15, desc: "Fast & cheap" },
  medium: { maxTokens: 8192, maxSteps: 40, desc: "Balanced (default)" },
  high: { maxTokens: 16384, maxSteps: 80, desc: "Maximum, long sessions" },
};

export const EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high"];

export function parseEffort(v: string): EffortLevel | null {
  const t = v.trim().toLowerCase();
  return (EFFORT_LEVELS as string[]).includes(t) ? (t as EffortLevel) : null;
}
