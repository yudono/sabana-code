// ─── Skills: instruksi kerja reusable ala Claude Code / OpenCode ───
// Sumber (prioritas rendah → tinggi):
//   1. <pkg>/skills/*.md + ~/sabana-code/skills/*.md  (global, di-seed dari template)
//   2. <workspace>/.sabana/skills/*.md                (per project, menang bila nama sama)
// Format = markdown + frontmatter (name, description). Dipakai dua cara:
//   - Disuntik ke konteks awal sebagai daftar (agent tahu kapan memakai).
//   - Tool `skill` memuat isi penuh satu skill saat dibutuhkan (hemat konteks).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { skillsDir } from "./home.js";
import type { ToolDefinition } from "./tools/types.js";

export interface SkillProfile {
  name: string;
  description: string;
  instructions: string;
  file: string;
  scope: "global" | "project";
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

function readDir(dir: string, scope: SkillProfile["scope"]): SkillProfile[] {
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    return [];
  }
  const out: SkillProfile[] = [];
  for (const f of files) {
    try {
      const raw = readFileSync(join(dir, f), "utf-8");
      const { meta, body } = parseFrontmatter(raw);
      const name = (meta.name || f.replace(/\.md$/, "")).toLowerCase();
      if (!name) continue;
      out.push({
        name,
        description: meta.description || "(tanpa deskripsi)",
        instructions: body,
        file: f,
        scope,
      });
    } catch {
      /* lewati file rusak */
    }
  }
  return out;
}

/** Semua skill: project menimpa global bila nama sama. */
export function listSkills(workspaceDir?: string): SkillProfile[] {
  const byName = new Map<string, SkillProfile>();
  for (const s of readDir(skillsDir(), "global")) byName.set(s.name, s);
  if (workspaceDir) {
    for (const s of readDir(join(workspaceDir, ".sabana", "skills"), "project")) {
      byName.set(s.name, s);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function loadSkill(name: string, workspaceDir?: string): SkillProfile | null {
  const lower = name.toLowerCase();
  return listSkills(workspaceDir).find((s) => s.name === lower) || null;
}

/** Blok ringkas untuk konteks awal: daftar skill + cara pakai. Kosong bila tak ada skill. */
export function buildSkillsContext(workspaceDir?: string): string {
  const skills = listSkills(workspaceDir);
  if (skills.length === 0) return "";
  const lines = skills.map((s) => `- ${s.name}: ${s.description}`);
  return [
    "## SKILLS (instruksi kerja siap pakai)",
    "Skill berikut tersedia. Bila tugas user cocok dengan salah satunya, panggil tool `skill` dengan nama itu DULU, ikuti instruksinya, lalu lanjutkan.",
    ...lines,
  ].join("\n");
}

// ─── Tool `skill`: muat isi penuh satu skill ───
export const skillTool: ToolDefinition = {
  name: "skill",
  description:
    "Muat instruksi penuh satu skill (lihat daftar via konteks SKILLS). Pakai sebelum mengerjakan tugas yang cocok (mis. skill=commit sebelum menulis commit message).",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Nama skill (mis. commit, review-pr)" },
    },
    required: ["name"],
  },
  permissions: { requiresPermission: false },
  timeout: 10_000,
  riskLevel: "safe",
};

export function skillHandler(workspaceDir: string) {
  return async (args: Record<string, unknown>) => {
    const name = String(args.name || "").toLowerCase();
    if (!name) return { error: "Missing required field: name" };
    // Batasi ke nama file aman (huruf/angka/dash/underscore).
    if (!/^[a-z0-9_-]+$/.test(name)) return { error: `Invalid skill name: ${name}` };
    const s = loadSkill(name, workspaceDir);
    if (!s) {
      const avail = listSkills(workspaceDir).map((x) => x.name).join(", ") || "(belum ada skill)";
      return { error: `Skill '${name}' tidak ada. Tersedia: ${avail}` };
    }
    return { name: s.name, description: s.description, scope: s.scope, instructions: s.instructions };
  };
}
