// ─── Tool registry — port dari sabana-dev apps/api/src/agents/tools/registry.ts ───
import type { ToolDefinitionForModel } from "../llm/types.js";
import type { ToolDefinition } from "./types.js";

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool);
  }
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }
  getAll(): ToolDefinition[] {
    return [...this.tools.values()];
  }
  toModelTools(): ToolDefinitionForModel[] {
    return this.getAll().map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema,
      },
    }));
  }
  validate(name: string, args: Record<string, unknown>): { valid: boolean; error?: string } {
    const tool = this.tools.get(name);
    if (!tool) return { valid: false, error: `Unknown tool: ${name}` };
    const schema = tool.inputSchema as { required?: string[] };
    if (schema.required) {
      for (const f of schema.required) {
        if (args[f] === undefined || args[f] === null) {
          return { valid: false, error: `Missing required field: ${f}` };
        }
      }
    }
    return { valid: true };
  }
}
