// ─── Global home à la opencode/claude-code: ~/sabana-code/ ───
//   sessions/  → every session/prompt stored here (JSON: history + context)
//   logs/      → daily activity logs
//   sabana.db  → sqlite: session index, credentials, usage
// Overridable via $SABANA_HOME (used by tests).
import { existsSync, mkdirSync, readdirSync, copyFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function sabanaHome(): string {
  return process.env.SABANA_HOME || join(homedir(), "sabana-code");
}

export function sessionsDir(): string {
  return join(sabanaHome(), "sessions");
}

export function projectsDir(): string {
  return join(sabanaHome(), "projects");
}

export function agentsDir(): string {
  return join(sabanaHome(), "agents");
}

export function skillsDir(): string {
  return join(sabanaHome(), "skills");
}

export function todosDir(): string {
  return join(sabanaHome(), "todos");
}

export function checkpointsDir(): string {
  return join(sabanaHome(), "checkpoints");
}

export function mcpPath(): string {
  return join(sabanaHome(), "mcp.json");
}

export function logsDir(): string {
  return join(sabanaHome(), "logs");
}

export function dbPath(): string {
  return join(sabanaHome(), "sabana.db");
}

/** Copy built-in agent profile templates into home (never overwrite user customizations). */
function seedDirTemplates(pkgSubdir: string, destDir: string): void {
  try {
    // Template location: <pkg>/agents or <pkg>/skills (dist/.. or src/..), cwd fallback (dev).
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [join(here, "..", pkgSubdir), join(process.cwd(), pkgSubdir)];
    for (const src of candidates) {
      if (!existsSync(src)) continue;
      for (const f of readdirSync(src)) {
        if (!f.endsWith(".md") && !f.endsWith(".json")) continue;
        const dest = join(destDir, f);
        if (!existsSync(dest)) copyFileSync(join(src, f), dest);
      }
      break;
    }
  } catch {
    /* best-effort */
  }
}
export function ensureHome(): string {
  const home = sabanaHome();
  mkdirSync(sessionsDir(), { recursive: true });
  mkdirSync(projectsDir(), { recursive: true });
  mkdirSync(agentsDir(), { recursive: true });
  mkdirSync(skillsDir(), { recursive: true });
  mkdirSync(todosDir(), { recursive: true });
  mkdirSync(checkpointsDir(), { recursive: true });
  mkdirSync(logsDir(), { recursive: true });
  seedDirTemplates("agents", agentsDir());
  seedDirTemplates("skills", skillsDir());

  // One-time migration from ~/.sabana-code/sessions (early TUI version)
  const marker = join(home, ".migrated");
  if (!existsSync(marker)) {
    try {
      const legacy = join(homedir(), ".sabana-code", "sessions");
      if (legacy !== sessionsDir() && existsSync(legacy)) {
        const existing = new Set(readdirSync(sessionsDir()));
        for (const f of readdirSync(legacy)) {
          if (f.endsWith(".json") && !existing.has(f)) {
            copyFileSync(join(legacy, f), join(sessionsDir(), f));
          }
        }
      }
    } catch {
      /* best-effort migration */
    }
    try {
      writeFileSync(marker, new Date().toISOString());
    } catch {
      /* ignore */
    }
  }
  return home;
}
