// ─── LLM types — adapted from sabana-dev apps/api/src/agents/core/types.ts ───

export type ModelEvent =
  | { type: "text_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: Record<string, unknown> }
  | { type: "tool_call_delta"; id: string; name?: string; args_delta: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "usage"; input: number; output: number; cached?: number; reasoning?: number }
  | { type: "finish"; stop_reason: string }
  | { type: "error"; message: string };

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface ToolDefinitionForModel {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ModelRequest {
  model: string;
  messages: ModelMessage[];
  tools?: ToolDefinitionForModel[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface ProviderConfig {
  name: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
}
