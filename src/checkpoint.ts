// ─── Checkpoint & rewind ala coding agent modern ───
// Stores snapshots (touched file contents + message history) per session in
// ~/sabana-code/checkpoints/<sessionId>/<cpId>.json. `/rewind <id>` mengembalikan
// file DAN riwayat ke titik itu — safe for experiments ("try first, rewind on failure → mundur").
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ModelMessage } from "./llm/types.js";
import type { Session } from "./session/store.js";
import { ensureHome, checkpointsDir } from "./home.js";
import { safePath } from "./tools/sandbox.js";

export interface FileSnapshot {
  path: string;
  /** null = file did not exist at checkpoint time (deleted on rewind). */
  content: string | null;
  /** true = file exists but is unreadable (binary/too large) → rewind TIDAK menyentuhnya. */
  skipped?: boolean;
}

export interface Checkpoint {
  id: string;
  label: string;
  createdAt: string;
  /** Full snapshot for deterministic rewinds. */
  messages: ModelMessage[];
  filesModified: string[];
  files: FileSnapshot[];
}

const MAX_CHECKPOINTS = 30;
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
    // Too large / binary → skip entirely (never restore, NEVER delete).
    if (buf.length > MAX_FILE_BYTES) return { content: null, skipped: true };
    if (buf.includes(0)) return { content: null, skipped: true };
    return { content: buf.toString("utf-8"), skipped: false };
  } catch {
    return { content: null, skipped: true };
  }
}

/** Create a checkpoint from the current session + file state. */
export function createCheckpoint(session: Session, workspaceDir: string, label?: string): Checkpoint {
  const dir = sessionDir(session.id);
  const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0")}`;
  const files: FileSnapshot[] = [];
  for (const rel of session.filesModified.slice(0, MAX_FILES)) {
    const full = safePath(workspaceDir, rel);
    if (!full) continue; // outside the workspace → skip
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
  // Prune old checkpoints (max 30 per session).
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
      /* skip corrupt files */
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

export interface CheckpointMeta {
  id: string;
  label: string;
  createdAt: string;
}

const SUBAGENT_PREFIX = "[sub-agent ";

/**
 * Pair user messages (in order) with checkpoints (ascending) by label.
 * Dipakai klik-kanan revert: tiap prompt user → checkpoint turn-nya.
 * Resilient to compact/pruning: sub-agent messages skipped (never own
 * checkpoint), duplikat teks dipasangkan berurutan (ke-1 → ke-1), yang tak
 * unmatched (pruned) ones get no pair. Returns an index→cpId map.
 */
export function pairPromptCheckpoints(userTexts: string[], cps: CheckpointMeta[]): Map<number, string> {
  const byLabel = new Map<string, string[]>();
  const sorted = [...cps].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  for (const c of sorted) {
    const arr = byLabel.get(c.label);
    if (arr) arr.push(c.id);
    else byLabel.set(c.label, [c.id]);
  }
  const used = new Map<string, number>();
  const out = new Map<number, string>();
  userTexts.forEach((t, i) => {
    if (t.startsWith(SUBAGENT_PREFIX)) return;
    const label = t.trim().slice(0, 80);
    const arr = byLabel.get(label);
    if (!arr) return;
    const k = used.get(label) || 0;
    if (k >= arr.length) return;
    used.set(label, k + 1);
    out.set(i, arr[k]);
  });
  return out;
}

export interface RewindResult {
  ok: boolean;
  restored: string[];
  deleted: string[];
  skipped: string[];
  error?: string;
}

/**
 * Restore session files + history to a checkpoint. Returns a NEW session
 * (caller must persist). Files outside the workspace are untouched.
 */
export function rewindToCheckpoint(session: Session, workspaceDir: string, id: string): { session: Session; result: RewindResult } {
  const cp = loadCheckpoint(session.id, id);
  if (!cp) {
    return { session, result: { ok: false, restored: [], deleted: [], skipped: [], error: `Checkpoint '${id}' not found.` } };
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
    // Files skipped at snapshot time (binary/huge) → never touch at all.
    if (snap.skipped) {
      skipped.push(snap.path);
      continue;
    }
    try {
      if (snap.content === null) {
        // File missing / unreadable at checkpoint time: delete only if it exists now
        // AND is a file (never delete directories).
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
