// ─── Tool types — adapted from sabana-dev apps/api/src/agents/core/types.ts ───

export type RiskLevel = "safe" | "moderate" | "dangerous";
export type PermissionDecision = "allow" | "ask" | "deny";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  permissions: { requiresPermission: boolean };
  timeout: number;
  riskLevel: RiskLevel;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  status: "success" | "error" | "timeout";
  output: unknown;
  durationMs: number;
}
