// ─── Sub-agents: custom AI profiles in ~/sabana-code/agents/*.md ───
// Each profile = markdown + frontmatter (name, description, optional model).
// Used to delegate specific tasks (review, audit, ...) to an "assistant"
// with its own instructions; the result returns to the main session.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SingleAgent } from "./agent.js";
import { agentsDir } from "./home.js";
import { SYSTEM_PROMPT } from "./prompt.js";
import type { ApprovalState, PermissionAsker } from "./utils/permissions.js";

export interface SubAgentProfile {
  name: string;
  description: string;
  model?: string;
  instructions: string;
  file: string;
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: raw.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) meta[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return { meta, body: (m[2] || "").trim() };
}

export function listAgents(): SubAgentProfile[] {
  let files: string[] = [];
  try {
    files = readdirSync(agentsDir()).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const out: SubAgentProfile[] = [];
  for (const f of files) {
    try {
      const raw = readFileSync(join(agentsDir(), f), "utf-8");
      const { meta, body } = parseFrontmatter(raw);
      out.push({
        name: meta.name || f.replace(/\.md$/, ""),
        description: meta.description || "(no description)",
        model: meta.model || undefined,
        instructions: body,
        file: f,
      });
    } catch {
      /* skip corrupt files */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function loadAgent(name: string): SubAgentProfile | null {
  const lower = name.toLowerCase();
  return listAgents().find((a) => a.name.toLowerCase() === lower) || null;
}

export interface SubAgentBase {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens: number;
  maxSteps: number;
  rpm?: number;
  approvals?: ApprovalState;
  askPermission?: PermissionAsker;
}

export interface SubAgentResult {
  text: string;
  files: string[];
  steps: number;
  success: boolean;
  approvals: ApprovalState;
}

/** Run one isolated sub-agent task (own history), return text. */
export async function runSubAgent(
  profile: SubAgentProfile,
  task: string,
  workspaceDir: string,
  base: SubAgentBase,
): Promise<SubAgentResult> {
  const agent = new SingleAgent({
    model: profile.model || base.model,
    provider: base.provider,
    apiKey: base.apiKey,
    baseUrl: base.baseUrl,
    maxTokens: base.maxTokens,
    maxSteps: base.maxSteps,
    // With an asker (TUI), sub-agents request permission through the same UI;
    // without one (benchmark/headless) they stay auto-approved as before.
    autoApprove: base.askPermission ? false : true,
    rpm: base.rpm ?? 60,
    approvals: base.approvals,
    askPermission: base.askPermission,
    onEvent: () => {},
  });
  const system =
    SYSTEM_PROMPT +
    `\n\n## PERAN KHUSUS: ${profile.name}\n${profile.instructions}\n\n` +
    `Complete the TASK below; your final answer is a report for the main session.`;
  const { result } = await agent.chatTurn(task, workspaceDir, [{ role: "system", content: system }]);
  return { text: result.finalText, files: result.filesModified, steps: result.steps, success: result.success, approvals: agent.getApprovals() };
}
