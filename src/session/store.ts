// ─── Session store global: ~/sabana-code/sessions/<uuid>.json ───
// Tiap new session / prompt baru tersimpan di sini (history + konteks),
// bisa dilanjutkan dari direktori mana pun (mirip opencode / claude-code).
// Index ringan disalin ke sqlite (~/sabana-code/sabana.db) untuk listing cepat.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ModelMessage } from "../llm/types.js";
import { ensureHome, sessionsDir } from "../home.js";
import { listSessionMeta, upsertSessionMeta } from "../db.js";
import { projectIdFor, registerProject } from "../projects.js";
import { contextUsage } from "./context.js";

export interface Session {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  provider: string;
  workspaceDir: string;
  /** ID project (hash path) — satu project bisa punya banyak session. */
  projectId: string;
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
    title: "Sesi baru",
    createdAt: now,
    updatedAt: now,
    model,
    provider,
    workspaceDir,
    projectId: projectIdFor(workspaceDir),
    messages: [],
    filesModified: [],
  };
}

export function saveSession(s: Session): void {
  s.updatedAt = new Date().toISOString();
  if (!s.projectId) s.projectId = projectIdFor(s.workspaceDir);
  registerProject(s.workspaceDir);
  if (s.title === "Sesi baru") {
    const firstUser = s.messages.find((m) => m.role === "user");
    if (firstUser) {
      // Pesan user pertama bisa berupa blob konteks awal ("## USER REQUEST\n<prompt>...").
      const lines = firstUser.content.split("\n");
      const reqIdx = lines.findIndex((l) => l.trim() === "## USER REQUEST");
      const raw = reqIdx >= 0 ? lines[reqIdx + 1] || "" : lines[0] || "";
      const t = raw.replace(/^#+\s*/, "").trim();
      if (t) s.title = t.slice(0, 60);
    }
  }
  writeFileSync(join(dir(), `${s.id}.json`), JSON.stringify(s, null, 2));
  // Sinkron index sqlite (best-effort)
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
    /* index opsional */
  }
}

export function loadSession(id: string): Session | null {
  // Dukung UUID penuh maupun prefix (seperti git short hash)
  const files = readdirSync(dir()).filter((f) => f.endsWith(".json"));
  const match = files.find((f) => f === `${id}.json`) || files.find((f) => f.startsWith(id));
  if (!match) return null;
  try {
    const s = JSON.parse(readFileSync(join(dir(), match), "utf-8")) as Session;
    if (!s.projectId) s.projectId = projectIdFor(s.workspaceDir); // backfill session lama
    return s;
  } catch {
    return null;
  }
}

export function sessionExists(id: string): boolean {
  return existsSync(join(dir(), `${id}.json`));
}

export function listSessions(): SessionSummary[] {
  // Sumber utama: sqlite (cepat); fallback: scan file bila db kosong.
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
      /* lewati file rusak */
    }
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function lastSession(): Session | null {
  const list = listSessions();
  return list.length > 0 ? loadSession(list[0].id) : null;
}
