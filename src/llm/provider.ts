// ─── LLM Provider — single-agent, OpenAI-compatible ───
// Adapted from sabana-dev apps/api/src/agents/llm/provider.ts
// Supports: openai (default, any OpenAI-compatible), anthropic, ollama.

import type {
  ModelEvent,
  ModelRequest,
  ProviderConfig,
} from "./types.js";
import { MockProvider } from "./mock.js";

export interface LLMProvider {
  readonly name: string;
  generate(request: ModelRequest): AsyncIterable<ModelEvent>;
}

export class OpenAIProvider implements LLMProvider {
  readonly name: string = "openai";
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
  }

  async *generate(request: ModelRequest): AsyncIterable<ModelEvent> {
    const body: Record<string, unknown> = {
      model: request.model || this.config.model,
      messages: request.messages,
      max_tokens: request.maxTokens || this.config.maxTokens,
      stream: true,
    };
    if (request.tools?.length) {
      body.tools = request.tools;
      body.parallel_tool_calls = true;
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;

    let res: Response;
    try {
      res = await fetch(`${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (e) {
      yield { type: "error", message: `LLM fetch failed: ${(e as Error).message}` };
      return;
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      yield { type: "error", message: `API error (${res.status}): ${errBody.slice(0, 500)}` };
      return;
    }

    const reader = res.body?.getReader();
    if (!reader) {
      yield { type: "error", message: "No response body" };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    const toolCalls = new Map<number, { id: string; name: string; args: string }>();

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let data = line.slice(6).trim();
          const doneIdx = data.indexOf("data: [DONE]");
          if (doneIdx >= 0) data = data.slice(0, doneIdx).trim();
          if (data === "[DONE]" || !data) continue;
          let parsed: any;
          try {
            parsed = JSON.parse(data);
          } catch {
            continue;
          }
          const choice = parsed.choices?.[0];
          if (!choice) continue;
          const delta = choice.delta ?? {};
          if (typeof delta.content === "string" && delta.content) {
            yield { type: "text_delta", text: delta.content };
          }
          const reasoning =
            (typeof delta.reasoning_content === "string" && delta.reasoning_content) ||
            (typeof delta.reasoning === "string" && delta.reasoning);
          if (reasoning) yield { type: "reasoning_delta", text: reasoning };

          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              if (!toolCalls.has(idx)) toolCalls.set(idx, { id: "", name: "", args: "" });
              const cur = toolCalls.get(idx)!;
              if (tc.id) cur.id = tc.id;
              if (tc.function?.name) cur.name = tc.function.name;
              if (tc.function?.arguments) cur.args += tc.function.arguments;
              yield {
                type: "tool_call_delta",
                id: cur.id,
                name: cur.name || undefined,
                args_delta: tc.function?.arguments || "",
              };
            }
          }
          if (parsed.usage) {
            yield {
              type: "usage",
              input: parsed.usage.prompt_tokens || 0,
              output: parsed.usage.completion_tokens || 0,
            };
          }
          if (choice.finish_reason) {
            for (const [, tc] of toolCalls) {
              if (tc.id && tc.name) {
                let args: Record<string, unknown> = {};
                try {
                  args = JSON.parse(tc.args || "{}");
                } catch {
                  /* biarkan {} */
                }
                yield { type: "tool_call", id: tc.id, name: tc.name, args };
              }
            }
            toolCalls.clear();
            yield { type: "finish", stop_reason: choice.finish_reason };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly name: string = "anthropic";
  private config: ProviderConfig;
  constructor(config: ProviderConfig) {
    this.config = config;
  }
  async *generate(request: ModelRequest): AsyncIterable<ModelEvent> {
    const system = request.messages.find((m) => m.role === "system");
    const conversation = request.messages.filter((m) => m.role !== "system");
    const body: Record<string, unknown> = {
      model: request.model || this.config.model,
      max_tokens: request.maxTokens || this.config.maxTokens,
      messages: conversation.map((m) => ({
        role: m.role === "tool" ? "user" : m.role,
        content: m.tool_call_id
          ? [{ type: "tool_result", tool_use_id: m.tool_call_id, content: m.content }]
          : m.content,
      })),
      stream: true,
    };
    if (system) body.system = system.content;
    if (request.tools?.length) {
      body.tools = request.tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }
    const res = await fetch(`${this.config.baseUrl.replace(/\/+$/, "")}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: request.signal,
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      yield { type: "error", message: `Anthropic API error (${res.status}): ${t.slice(0, 500)}` };
      return;
    }
    const reader = res.body?.getReader();
    if (!reader) {
      yield { type: "error", message: "No response body" };
      return;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    let cur: { id: string; name: string; args: string } | null = null;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          let parsed: any;
          try {
            parsed = JSON.parse(line.slice(6));
          } catch {
            continue;
          }
          if (parsed.type === "content_block_start" && parsed.content_block?.type === "tool_use") {
            cur = { id: parsed.content_block.id, name: parsed.content_block.name, args: "" };
          } else if (parsed.type === "content_block_delta") {
            const d = parsed.delta ?? {};
            if (d.type === "text_delta" && d.text) yield { type: "text_delta", text: d.text };
            if (d.type === "input_json_delta" && d.partial_json && cur) {
              cur.args += d.partial_json;
              yield { type: "tool_call_delta", id: cur.id, args_delta: d.partial_json };
            }
          } else if (parsed.type === "content_block_stop" && cur) {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(cur.args || "{}");
            } catch {
              /* ignore */
            }
            yield { type: "tool_call", id: cur.id, name: cur.name, args };
            cur = null;
          } else if (parsed.type === "message_delta") {
            yield { type: "finish", stop_reason: parsed.delta?.stop_reason || "end_turn" };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

export class OllamaProvider extends OpenAIProvider {
  override readonly name: string = "ollama";
  constructor(config: ProviderConfig) {
    super({ ...config, baseUrl: config.baseUrl || "http://localhost:11434/v1" });
  }
}

export function createProvider(name: string, config: ProviderConfig): LLMProvider {
  switch (name) {
    case "mock":
      return new MockProvider();
    case "anthropic":
      return new AnthropicProvider(config);
    case "ollama":
      return new OllamaProvider(config);
    case "openai":
    default:
      return new OpenAIProvider(config);
  }
}
