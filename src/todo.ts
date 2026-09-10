// ─── Todo queue ala Claude Code (TodoWrite): multi-step work plans ───
// Disimpan per project: ~/sabana-code/todos/<projectHash>.json — jadi antrean
// survives session switches. The agent uses `todo_write` / `todo_list`,
// users watch via /todo in the TUI.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHome, todosDir } from "./home.js";
import { projectIdFor } from "./projects.js";
import type { ToolDefinition } from "./tools/types.js";

export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoPriority = "high" | "medium" | "low";

export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
  priority: TodoPriority;
}

export interface TodoList {
  updatedAt: string;
  items: TodoItem[];
}

const MAX_TODOS = 50;
const VALID_STATUS: TodoStatus[] = ["pending", "in_progress", "completed"];
const VALID_PRIORITY: TodoPriority[] = ["high", "medium", "low"];

function fileFor(workspaceDir: string): string {
  ensureHome();
  mkdirSync(todosDir(), { recursive: true });
  return join(todosDir(), `${projectIdFor(workspaceDir)}.json`);
}

export function loadTodos(workspaceDir: string): TodoList {
  const f = fileFor(workspaceDir);
  try {
    const raw = JSON.parse(readFileSync(f, "utf-8")) as Partial<TodoList>;
    const items = Array.isArray(raw.items) ? raw.items : [];
    return {
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
      items: items.filter((t) => t && typeof t.content === "string").map((t, i) => ({
        id: typeof t.id === "string" && t.id ? t.id : `t${i + 1}`,
        content: t.content.slice(0, 300),
        status: VALID_STATUS.includes(t.status) ? t.status : "pending",
        priority: VALID_PRIORITY.includes(t.priority) ? t.priority : "medium",
      })).slice(0, MAX_TODOS),
    };
  } catch {
    return { updatedAt: new Date(0).toISOString(), items: [] };
  }
}

export function saveTodos(workspaceDir: string, items: TodoItem[]): TodoList {
  const list: TodoList = { updatedAt: new Date().toISOString(), items: items.slice(0, MAX_TODOS) };
  writeFileSync(fileFor(workspaceDir), JSON.stringify(list, null, 2) + "\n");
  return list;
}

function cleanInput(raw: unknown): { ok: true; items: TodoItem[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "todos must be an array of {content, status, priority}" };
  if (raw.length > MAX_TODOS) return { ok: false, error: `Max ${MAX_TODOS} todos per project` };
  const seen = new Set<string>();
  const items: TodoItem[] = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i] as Partial<TodoItem>;
    const content = typeof t?.content === "string" ? t.content.trim().slice(0, 300) : "";
    if (!content) return { ok: false, error: `todos[${i}].content is required` };
    const status = VALID_STATUS.includes(t.status as TodoStatus) ? (t.status as TodoStatus) : "pending";
    const priority = VALID_PRIORITY.includes(t.priority as TodoPriority) ? (t.priority as TodoPriority) : "medium";
    const id = typeof t.id === "string" && t.id.trim() ? t.id.trim().slice(0, 40) : `t${i + 1}`;
    if (seen.has(id)) return { ok: false, error: `duplicate id: ${id}` };
    seen.add(id);
    items.push({ id, content, status, priority });
  }
  // Maks 1 in_progress — stops the agent "working on everything at once".
  const active = items.filter((t) => t.status === "in_progress");
  if (active.length > 1) return { ok: false, error: "Max 1 in_progress todo at a time" };
  return { ok: true, items };
}

/** One concise line for TUI display / tool summaries. */
export function formatTodos(items: TodoItem[]): string {
  if (items.length === 0) return "(no todos yet)";
  const icon = { pending: "○", in_progress: "◐", completed: "●" } as const;
  return items
    .map((t) => `  ${icon[t.status]} [${t.priority}] ${t.content}`)
    .join("\n");
}

// ─── Tools ───
export const todoWriteTool: ToolDefinition = {
  name: "todo_write",
  description:
    "Write/refresh the ENTIRE todo list (max 50, max 1 in_progress). Use for multi-step tasks: break into small steps, mark in_progress while working, completed when done.",
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "Complete todo list (replaces the old one)",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            content: { type: "string" },
            status: { type: "string", description: "pending | in_progress | completed" },
            priority: { type: "string", description: "high | medium | low" },
          },
          required: ["content"],
        },
      },
    },
    required: ["todos"],
  },
  permissions: { requiresPermission: false },
  timeout: 10_000,
  riskLevel: "safe",
};

export const todoListTool: ToolDefinition = {
  name: "todo_list",
  description: "Read the current project todo list (no changes).",
  inputSchema: { type: "object", properties: {} },
  permissions: { requiresPermission: false },
  timeout: 10_000,
  riskLevel: "safe",
};

export function todoWriteHandler(workspaceDir: string) {
  return async (args: Record<string, unknown>) => {
    const cleaned = cleanInput(args.todos);
    if (!cleaned.ok) return { error: cleaned.error };
    const list = saveTodos(workspaceDir, cleaned.items);
    const done = list.items.filter((t) => t.status === "completed").length;
    return { updated: true, total: list.items.length, completed: done, todos: list.items };
  };
}

export function todoListHandler(workspaceDir: string) {
  return async (_args: Record<string, unknown>) => {
    const list = loadTodos(workspaceDir);
    if (!existsSync(fileFor(workspaceDir))) return { todos: [], total: 0, completed: 0 };
    const done = list.items.filter((t) => t.status === "completed").length;
    return { todos: list.items, total: list.items.length, completed: done };
  };
}
