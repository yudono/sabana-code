// ─── projects/: session history grouped per project folder ───
// Open a terminal anywhere → the project is detected from cwd (path hash).
// One project can own many sessions. sessions/ holds session contents,
// projects/ holds project metadata — related but different things.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { ensureHome, projectsDir } from "./home.js";
import { getDb } from "./db.js";

export interface ProjectInfo {
  id: string;
  path: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

/** Stable ID from the absolute path (same no matter when opened). */
export function projectIdFor(cwd: string): string {
  return createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
}

function infoPath(id: string): string {
  return `${projectsDir()}/${id}/info.json`;
}

/** Register / touch a project when a session opens in that cwd. */
export function registerProject(cwd: string): ProjectInfo {
  ensureHome();
  const path = resolve(cwd);
  const id = projectIdFor(path);
  mkdirSync(`${projectsDir()}/${id}`, { recursive: true });
  const now = new Date().toISOString();
  let info: ProjectInfo;
  try {
    info = JSON.parse(readFileSync(infoPath(id), "utf-8")) as ProjectInfo;
    info.updatedAt = now;
    info.path = path;
    info.name = basename(path);
  } catch {
    info = { id, path, name: basename(path) || path, createdAt: now, updatedAt: now };
  }
  writeFileSync(infoPath(id), JSON.stringify(info, null, 2));
  return info;
}

export function getProject(idOrPath: string): ProjectInfo | null {
  ensureHome();
  const id = existsSync(resolve(idOrPath)) ? projectIdFor(idOrPath) : idOrPath;
  try {
    return JSON.parse(readFileSync(infoPath(id), "utf-8")) as ProjectInfo;
  } catch {
    return null;
  }
}

export interface ProjectSummary extends ProjectInfo {
  sessions: number;
  lastActive: string;
}

/** List projects + count sessions per project (from the sqlite index). */
export function listProjects(): ProjectSummary[] {
  ensureHome();
  let dirs: string[] = [];
  try {
    dirs = readdirSync(projectsDir(), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const counts = new Map<string, number>();
  try {
    const rows = getDb()
      .prepare(`SELECT project_id AS id, COUNT(*) AS n FROM sessions WHERE project_id <> '' GROUP BY project_id`)
      .all() as unknown as Array<{ id: string; n: number }>;
    for (const r of rows) counts.set(r.id, r.n);
  } catch {
    /* index opsional */
  }
  const out: ProjectSummary[] = [];
  for (const id of dirs) {
    try {
      const info = JSON.parse(readFileSync(infoPath(id), "utf-8")) as ProjectInfo;
      out.push({ ...info, sessions: counts.get(id) || 0, lastActive: info.updatedAt });
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => (a.lastActive < b.lastActive ? 1 : -1));
}

/** Sessions owned by one project (newest first). */
export function projectSessions(projectId: string, limit = 20): Array<{ id: string; title: string; updatedAt: string }> {
  try {
    const rows = getDb()
      .prepare(`SELECT id, title, updated_at AS updatedAt FROM sessions WHERE project_id = ? ORDER BY updated_at DESC LIMIT ?`)
      .all(projectId, limit) as unknown as Array<{ id: string; title: string; updatedAt: string }>;
    if (rows.length > 0) return rows;
  } catch {
    /* fallback scan file */
  }
  return [];
}
