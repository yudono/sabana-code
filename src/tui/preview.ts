// ─── Resolver konten pratinjau fullscreen untuk baris tool ───
// read_file/write_file  → baca LIVE dari disk (segar, termasuk edit susulan).
// modified_file         → diff tersimpan saat eksekusi (old content sudah hilang).
// delete_file           → catatan penghapusan tersimpan.
// shell                 → stdout/stderr tersimpan. Lainnya → output mentah.

import { existsSync, readFileSync, statSync } from "node:fs";
import { safePath } from "../tools/sandbox.js";
import { detectLang, type HlLang } from "./highlight.js";
import type { PreviewRef } from "./App.js";

export interface PreviewData {
  title: string;
  lang: HlLang;
  body: string;
}

export const PREVIEW_LINES_CAP = 1500;
export const PREVIEW_CHARS_CAP = 60_000;

function capBody(s: string): string {
  let lines = s.split("\n");
  let cut = false;
  if (lines.length > PREVIEW_LINES_CAP) {
    lines = lines.slice(0, PREVIEW_LINES_CAP);
    cut = true;
  }
  let body = lines.join("\n");
  if (body.length > PREVIEW_CHARS_CAP) {
    body = body.slice(0, PREVIEW_CHARS_CAP);
    cut = true;
  }
  return cut ? body + "\n… [dipotong]" : body;
}

function withLineNumbers(content: string): string {
  return content
    .split("\n")
    .map((l, i) => `${String(i + 1).padStart(4, " ")}  ${l}`)
    .join("\n");
}

function parseStored(stored: string | undefined): unknown {
  if (!stored) return undefined;
  const t = stored.trim();
  if (!(t.startsWith("{") && t.endsWith("}"))) return stored;
  try {
    return JSON.parse(t);
  } catch {
    return stored;
  }
}

function readDiskFile(
  workspaceDir: string,
  path: string,
): { ok: true; content: string } | { ok: false; error: string } {
  const full = safePath(workspaceDir, path);
  if (!full) return { ok: false, error: `Path escapes workspace: ${path}` };
  try {
    if (!existsSync(full)) return { ok: false, error: `File tidak ada (mungkin sudah dihapus): ${path}` };
    if (statSync(full).isDirectory()) return { ok: false, error: `Is a directory: ${path}` };
    const content = readFileSync(full, "utf-8");
    if (content.includes("\0")) return { ok: false, error: `File biner — pratinjau teks dinonaktifkan: ${path}` };
    return { ok: true, content };
  } catch (e) {
    return { ok: false, error: `Gagal baca: ${(e as Error).message}` };
  }
}

function storedFallback(path: string, stored: string | undefined): string {
  return stored && stored.trim() ? stored : `(tidak ada output tersimpan untuk ${path})`;
}

/** Bangun konten pratinjau dari item tool. Pure kecuali baca disk untuk read/write. */
export function buildPreviewForTool(
  item: { name: string; preview: PreviewRef; summary: string; output?: string },
  workspaceDir: string,
): PreviewData {
  const { name, preview: ref } = item;
  const path = ref.path || "";
  const cap = (body: string) => capBody(body);

  switch (name) {
    case "read_file":
    case "write_file": {
      const title = `${name} ${path}`;
      const r = readDiskFile(workspaceDir, path);
      if (!r.ok) {
        const fb = storedFallback(path, item.output);
        return { title, lang: "plain", body: cap(`${r.error}${fb ? `\n\n--- output tersimpan ---\n${fb}` : ""}`) };
      }
      return { title, lang: detectLang(path), body: cap(withLineNumbers(r.content)) };
    }

    case "modified_file": {
      const title = `${name} ${path}`;
      const p = parseStored(item.output);
      const diff =
        typeof p === "string" && p.startsWith("--- ")
          ? p
          : p && typeof p === "object" && typeof (p as { diff?: unknown }).diff === "string"
            ? ((p as { diff: string }).diff as string)
            : undefined;
      if (!diff) return { title, lang: "plain", body: "Diff tidak tersimpan untuk panggilan ini." };
      return { title, lang: "diff", body: cap(diff) };
    }

    case "delete_file": {
      const title = `${name} ${path}`;
      const p = parseStored(item.output);
      if (p && typeof p === "object") {
        const r = p as Record<string, unknown>;
        if (typeof r.error === "string") {
          return { title, lang: "plain", body: cap(`Gagal menghapus ${path}:\n${r.error}`) };
        }
        return {
          title,
          lang: "plain",
          body: `Dihapus: ${path}${r.directory ? " (direktori kosong)" : ""}`,
        };
      }
      return { title, lang: "plain", body: cap(`Dihapus: ${path}`) };
    }

    case "shell": {
      const cmd = ref.command || "";
      const title = (`$ ${cmd}` || "$ shell").slice(0, 100);
      const p = parseStored(item.output);
      const lines: string[] = [`$ ${cmd}`];
      if (p && typeof p === "object") {
        const r = p as Record<string, unknown>;
        if (typeof r.exitCode === "number" || typeof r.durationMs === "number") {
          lines.push(
            `[exit ${typeof r.exitCode === "number" ? r.exitCode : "?"}]` +
              (typeof r.durationMs === "number" ? ` · ${r.durationMs}ms` : ""),
          );
        }
        if (typeof r.stdout === "string" && r.stdout) lines.push(`--- stdout ---\n${r.stdout}`);
        if (typeof r.stderr === "string" && r.stderr) lines.push(`--- stderr ---\n${r.stderr}`);
        if (typeof r.error === "string" && r.error) lines.push(`ERROR: ${r.error}`);
      } else if (typeof p === "string" && p) {
        lines.push(p);
      } else {
        lines.push("(tidak ada output tersimpan)");
      }
      return { title, lang: "plain", body: cap(lines.join("\n")) };
    }

    default: {
      const p = parseStored(item.output);
      const body =
        p === undefined
          ? "(tidak ada output tersimpan)"
          : typeof p === "string"
            ? p
            : JSON.stringify(p, null, 2);
      return { title: item.summary || name, lang: "plain", body: cap(body) };
    }
  }
}
