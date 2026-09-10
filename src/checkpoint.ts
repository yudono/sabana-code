// ─── Checkpoint & rewind ala coding agent modern ───
// Menyimpan snapshot (isi file yang disentuh + riwayat pesan) per session di
// ~/sabana-code/checkpoints/<sessionId>/<cpId>.json. `/rewind <id>` mengembalikan
// file DAN riwayat ke titik itu — aman untuk eksperimen ("coba dulu, gagal → mundur").
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelMessage } from "./llm/types.js";
import type { Session } from "./session/store.js";
import { ensureHome, checkpointsDir } from "./home.js";
import { safePath } from "./tools/sandbox.js";

export interface FileSnapshot {
  path: string;
  /** null = file belum ada saat checkpoint (akan dihapus saat rewind). */
  content: string | null;
  /** true = file ada tapi tak terbaca (biner/terlalu besar) → rewind TIDAK menyentuhnya. */
  skipped?: boolean;
}

export interface Checkpoint {
  id: string;
  label: string;
  createdAt: string;
  /** Snapshot penuh agar rewind deterministik. */
  messages: ModelMessage[];
  filesModified: string[];
  files: FileSnapshot[];
}

const MAX_CHECKPOINTS = 20;
const MAX_FILE_BYTES = 500_000;
const MAX_FILES = 100;

function sessionDir(sessionId: string): string {
  ensureHome();
  const d = join(checkpointsDir(), sessionId);
  mkdirSync(d, { recursive: true });
  return d;
}

function readText(full: string): { content: string | null; skipped: boolean } {
  try {
    if (!existsSync(full)) return { content: null, skipped: false };
    const buf = readFileSync(full);
    // Terlalu besar / biner → lewati total (jangan di-restore, JANGAN dihapus).
    if (buf.length > MAX_FILE_BYTES) return { content: null, skipped: true };
    if (buf.includes(0)) return { content: null, skipped: true };
    return { content: buf.toString("utf-8"), skipped: false };
  } catch {
    return { content: null, skipped: true };
  }
}

/** Buat checkpoint dari kondisi session + file saat ini. */
export function createCheckpoint(session: Session, workspaceDir: string, label?: string): Checkpoint {
  const dir = sessionDir(session.id);
  const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0")}`;
  const files: FileSnapshot[] = [];
  for (const rel of session.filesModified.slice(0, MAX_FILES)) {
    const full = safePath(workspaceDir, rel);
    if (!full) continue; // di luar workspace → lewati
    const r = readText(full);
    files.push({ path: rel, content: r.content, ...(r.skipped ? { skipped: true as const } : {}) });
  }
  const cp: Checkpoint = {
    id,
    label: (label || "").trim().slice(0, 80) || `checkpoint-${id.slice(0, 6)}`,
    createdAt: new Date().toISOString(),
    messages: session.messages,
    filesModified: [...session.filesModified],
    files,
  };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(cp));
  // Pangkas checkpoint lama (maks 20 per session).
  try {
    const all = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    for (const f of all.slice(0, Math.max(0, all.length - MAX_CHECKPOINTS))) {
      rmSync(join(dir, f));
    }
  } catch {
    /* best-effort */
  }
  return cp;
}

export function listCheckpoints(sessionId: string): Array<Pick<Checkpoint, "id" | "label" | "createdAt"> & { messages: number; files: number }> {
  let files: string[] = [];
  try {
    files = readdirSync(sessionDir(sessionId)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: Array<Pick<Checkpoint, "id" | "label" | "createdAt"> & { messages: number; files: number }> = [];
  for (const f of files) {
    try {
      const cp = JSON.parse(readFileSync(join(sessionDir(sessionId), f), "utf-8")) as Checkpoint;
      out.push({ id: cp.id, label: cp.label, createdAt: cp.createdAt, messages: cp.messages.length, files: cp.files.length });
    } catch {
      /* lewati file rusak */
    }
  }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function loadCheckpoint(sessionId: string, id: string): Checkpoint | null {
  const dir = sessionDir(sessionId);
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  } catch {
    return null;
  }
  const match = files.find((f) => f === `${id}.json`) || files.find((f) => f.startsWith(id));
  if (!match) return null;
  try {
    return JSON.parse(readFileSync(join(dir, match), "utf-8")) as Checkpoint;
  } catch {
    return null;
  }
}

export interface RewindResult {
  ok: boolean;
  restored: string[];
  deleted: string[];
  skipped: string[];
  error?: string;
}

/**
 * Kembalikan file + riwayat session ke checkpoint. Mengembalikan session BARU
 * (caller wajib persist). File di luar workspace tidak disentuh.
 */
export function rewindToCheckpoint(session: Session, workspaceDir: string, id: string): { session: Session; result: RewindResult } {
  const cp = loadCheckpoint(session.id, id);
  if (!cp) {
    return { session, result: { ok: false, restored: [], deleted: [], skipped: [], error: `Checkpoint '${id}' tidak ditemukan.` } };
  }
  const restored: string[] = [];
  const deleted: string[] = [];
  const skipped: string[] = [];
  for (const snap of cp.files) {
    const full = safePath(workspaceDir, snap.path);
    if (!full) {
      skipped.push(snap.path);
      continue;
    }
    // File yang di-skip saat snapshot (biner/raksasa) → jangan sentuh sama sekali.
    if (snap.skipped) {
      skipped.push(snap.path);
      continue;
    }
    try {
      if (snap.content === null) {
        // File tidak ada / tak terbaca saat checkpoint: hapus hanya bila kini ada
        // DAN berupa file (jangan hapus direktori).
        if (existsSync(full)) {
          try {
            if (statSync(full).isFile()) {
              rmSync(full);
              deleted.push(snap.path);
            } else skipped.push(snap.path);
          } catch {
            skipped.push(snap.path);
          }
        }
      } else {
        mkdirSync(dirname(full), { recursive: true });
        writeFileSync(full, snap.content, "utf-8");
        restored.push(snap.path);
      }
    } catch {
      skipped.push(snap.path);
    }
  }
  const next: Session = {
    ...session,
    messages: cp.messages,
    filesModified: [...cp.filesModified],
    updatedAt: new Date().toISOString(),
  };
  return { session: next, result: { ok: true, restored, deleted, skipped } };
}
