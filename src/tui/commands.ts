// ─── Slash-command TUI: parse + help list + autocomplete ───

export interface ParsedCommand {
  name: string;
  args: string[];
}

export function parseCommand(input: string): ParsedCommand | null {
  const t = input.trim();
  if (!t.startsWith("/")) return null;
  const parts = t.slice(1).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return { name: parts[0].toLowerCase(), args: parts.slice(1) };
}

export const COMMAND_LIST: Array<{ name: string; usage: string; desc: string }> = [
  { name: "/help", usage: "/help", desc: "Show this help" },
  { name: "/new", usage: "/new", desc: "Start a new session" },
  { name: "/sessions", usage: "/sessions", desc: "List all saved sessions" },
  { name: "/projects", usage: "/projects", desc: "List projects + session counts" },
  { name: "/agents", usage: "/agents", desc: "List custom sub-agent profiles" },
  { name: "/agent", usage: "/agent <name> <task>", desc: "Delegate a task to a sub-agent" },
  { name: "/skills", usage: "/skills", desc: "List available work skills" },
  { name: "/skill", usage: "/skill <name>", desc: "View one skill's full instructions" },
  { name: "/todo", usage: "/todo", desc: "View the project todo queue" },
  { name: "/mcp", usage: "/mcp [reload]", desc: "MCP server status + tools" },
  { name: "/checkpoint", usage: "/checkpoint [label]", desc: "Save a safe point (files + history)" },
  { name: "/checkpoints", usage: "/checkpoints", desc: "List this session's safe points" },
  { name: "/rewind", usage: "/rewind <id>", desc: "Rewind to a checkpoint (restore files + history)" },
  { name: "/resume", usage: "/resume <id|number>", desc: "Resume a session (id prefix ok)" },
  { name: "/models", usage: "/models [filter|number|name]", desc: "Live provider model list + select" },
  { name: "/providers", usage: "/providers [use|login ...]", desc: "Manage connected multi-providers" },
  { name: "/compact", usage: "/compact", desc: "Compact context now (auto past 80%)" },
  { name: "/login", usage: "/login <provider> <key>", desc: "Save API key to ~/sabana-code/ (global)" },
  { name: "/logout", usage: "/logout [provider]", desc: "View / remove stored credentials" },
  { name: "/context", usage: "/context", desc: "Show active model context usage" },
  { name: "/tools", usage: "/tools", desc: "List agent tools" },
  { name: "/clear", usage: "/clear", desc: "Clear screen (context history kept)" },
  { name: "/quit", usage: "/quit", desc: "Save session & exit (alias /exit)" },
];

export function helpText(): string {
  return ["Available commands:", ...COMMAND_LIST.map((c) => `  ${c.usage.padEnd(22)} ${c.desc}`)].join("\n");
}

/**
 * Autocomplete: filter command names by what the user typed after "/".
 * Returns matching command names ("/" alone → all). Empty when the input
 * is not a slash prefix or already names an exact command with arguments.
 */
export function suggestCommands(input: string): string[] {
  if (!input.startsWith("/")) return [];
  const rest = input.slice(1);
  if (/\s/.test(rest)) {
    // Exact command + args typed → nothing to suggest.
    const first = rest.split(/\s+/)[0]?.toLowerCase();
    if (COMMAND_LIST.some((c) => c.name === `/${first}`)) return [];
    return [];
  }
  const prefix = rest.toLowerCase();
  return COMMAND_LIST.filter((c) => c.name.slice(1).startsWith(prefix)).map((c) => c.name);
}

/**
 * Cocokkan nama model persis (case-insensitive) ke daftar live terakhir
 * or catalog — for manual input via `/models <name>`.
 */
export function matchModelName(arg: string, liveModels: string[], catalogIds: string[]): string | null {
  const lower = arg.trim().toLowerCase();
  if (!lower) return null;
  return (
    liveModels.find((m) => m.toLowerCase() === lower) ??
    catalogIds.find((m) => m.toLowerCase() === lower) ??
    null
  );
}
