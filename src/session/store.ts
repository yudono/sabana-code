// ─── Global session store: ~/sabana-code/sessions/<uuid>.json ───
// Every new session / prompt is stored here (history + context),
// resumable from any directory (like opencode / claude-code).
// A light index is mirrored to sqlite (~/sabana-code/sabana.db) for fast listing.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ModelMessage } from "../llm/types.js";
import { ensureHome, sessionsDir } from "../home.js";
import { listSessionMeta, upsertSessionMeta } from "../db.js";
import { projectIdFor, registerProject } from "../projects.js";
import { contextUsage } from "./context.js";
import { emptyApprovals, type ApprovalState } from "../utils/permissions.js";

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  provider: string;
  workspaceDir: string;
  /** Project ID (path hash) — one project can own many sessions. */
  projectId: string;
  /** Per-session terminal/file permission decisions (allow all/deny). New sessions start empty. */
  approvals: ApprovalState;
  /** Effort preset name (controls maxTokens/maxSteps). Missing = medium. */
  effort?: string;
  messages: ModelMessage[];
  filesModified: string[];
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  model: string;
  provider: string;
  turns: number;
}

function dir(): string {
  ensureHome();
  mkdirSync(sessionsDir(), { recursive: true });
  return sessionsDir();
}

export function newSessionId(): string {
  return randomUUID();
}

export function shortId(id: string): string {
  return id.replace(/-/g, "").slice(0, 8);
}

export function createSession(model: string, provider: string, workspaceDir: string): Session {
  const now = new Date().toISOString();
  return {
    id: newSessionId(),
    title: "New session",
    createdAt: now,
    updatedAt: now,
    model,
    provider,
    workspaceDir,
    projectId: projectIdFor(workspaceDir),
    approvals: emptyApprovals(),
    messages: [],
    filesModified: [],
  };
}

export function saveSession(s: Session): void {
  s.updatedAt = new Date().toISOString();
  if (!s.projectId) s.projectId = projectIdFor(s.workspaceDir);
  registerProject(s.workspaceDir);
  if (s.title === "New session") {
    const firstUser = s.messages.find((m) => m.role === "user");
    if (firstUser) {
      // The first user message may be an initial-context blob ("## USER REQUEST\n<prompt>...").
      const lines = firstUser.content.split("\n");
      const reqIdx = lines.findIndex((l) => l.trim() === "## USER REQUEST");
      const raw = reqIdx >= 0 ? lines[reqIdx + 1] || "" : lines[0] || "";
      const t = raw.replace(/^#+\s*/, "").trim();
      if (t) s.title = t.slice(0, 60);
    }
  }
  writeFileSync(join(dir(), `${s.id}.json`), JSON.stringify(s, null, 2));
  // Sync the sqlite index (best-effort)
  try {
    const usage = contextUsage(s.messages, s.model, s.provider);
    upsertSessionMeta({
      id: s.id,
      title: s.title,
      cwd: s.workspaceDir,
      project_id: s.projectId,
      model: s.model,
      provider: s.provider,
      created_at: s.createdAt,
      updated_at: s.updatedAt,
      turns: s.messages.filter((m) => m.role === "user").length,
      est_tokens: usage.tokens,
    });
  } catch {
    /* index is optional */
  }
}

export function loadSession(id: string): Session | null {
  // Supports full UUIDs and prefixes (like git short hashes)
  const files = readdirSync(dir()).filter((f) => f.endsWith(".json"));
  const match = files.find((f) => f === `${id}.json`) || files.find((f) => f.startsWith(id));
  if (!match) return null;
  try {
    const s = JSON.parse(readFileSync(join(dir(), match), "utf-8")) as Session;
    if (!s.projectId) s.projectId = projectIdFor(s.workspaceDir); // backfill old sessions
    if (!s.approvals) s.approvals = emptyApprovals(); // backfill: old approvals are not carried over
    if (!s.effort) s.effort = "medium"; // backfill old sessions
    return s;
  } catch {
    return null;
  }
}

export function sessionExists(id: string): boolean {
  return existsSync(join(dir(), `${id}.json`));
}

export function listSessions(): SessionSummary[] {
  // Primary source: sqlite (fast); fallback: file scan when db is empty.
  try {
    const rows = listSessionMeta(50);
    if (rows.length > 0) {
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        updatedAt: r.updated_at,
        model: r.model,
        provider: r.provider,
        turns: r.turns,
      }));
    }
  } catch {
    /* fallback ke file */
  }
  const out: SessionSummary[] = [];
  let files: string[] = [];
  try {
    files = readdirSync(dir()).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  for (const f of files) {
    try {
      const s = JSON.parse(readFileSync(join(dir(), f), "utf-8")) as Session;
      out.push({
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        model: s.model,
        provider: s.provider,
        turns: s.messages.filter((m) => m.role === "user").length,
      });
    } catch {
      /* skip corrupt files */
    }
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function lastSession(): Session | null {
  const list = listSessions();
  return list.length > 0 ? loadSession(list[0].id) : null;
}
