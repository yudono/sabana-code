// ─── Global home ala opencode/claude-code: ~/sabana-code/ ───
//   sessions/  → tiap session/prompt tersimpan di sini (JSON: history + context)
//   logs/      → log aktivitas harian
//   sabana.db  → sqlite: index session, credentials, usage
// Bisa di-override via $SABANA_HOME (dipakai tests).
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

/** Salin template profil agents bawaan ke home (tanpa menimpa kustom user). */
function seedDirTemplates(pkgSubdir: string, destDir: string): void {
  try {
    // Lokasi template: <pkg>/agents atau <pkg>/skills (dist/.. atau src/..), fallback cwd (dev).
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

  // Migrasi sekali dari ~/.sabana-code/sessions (versi TUI awal)
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
      /* migrasi best-effort */
    }
    try {
      writeFileSync(marker, new Date().toISOString());
    } catch {
      /* abaikan */
    }
  }
  return home;
}
