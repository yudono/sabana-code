// ─── sqlite global (node:sqlite bawaan, tanpa dependensi) ───
// Tabel: sessions (index cepat), usage (jejak token).
// (Kredensial tinggal di settings.json, bukan di sini.)
import { DatabaseSync } from "node:sqlite";
import { dbPath, ensureHome } from "./home.js";

export interface SessionMeta {
  id: string;
  title: string;
  cwd: string;
  project_id: string;
  model: string;
  provider: string;
  created_at: string;
  updated_at: string;
  turns: number;
  est_tokens: number;
}

export interface UsageRow {
  session_id: string;
  at: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
}

const dbs = new Map<string, DatabaseSync>();

export function getDb(): DatabaseSync {
  ensureHome();
  const path = dbPath();
  let db = dbs.get(path);
  if (!db) {
    db = new DatabaseSync(path);
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, title TEXT, cwd TEXT, model TEXT, provider TEXT,
        created_at TEXT, updated_at TEXT, turns INTEGER DEFAULT 0, est_tokens INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, at TEXT,
        model TEXT, input_tokens INTEGER DEFAULT 0, output_tokens INTEGER DEFAULT 0
      );
      DROP TABLE IF EXISTS credentials;
    `);
    // Migrasi: kolom project_id untuk db lama
    try {
      db.exec(`ALTER TABLE sessions ADD COLUMN project_id TEXT DEFAULT ''`);
    } catch {
      /* sudah ada */
    }
    dbs.set(path, db);
  }
  return db;
}

/** Tutup koneksi (dipakai tests agar file db bisa dibersihkan). */
export function closeDb(): void {
  for (const [, db] of dbs) {
    try {
      db.close();
    } catch {
      /* abaikan */
    }
  }
  dbs.clear();
}

// ─── sessions index ───

export function upsertSessionMeta(m: SessionMeta): void {
  getDb()
    .prepare(
      `INSERT INTO sessions (id, title, cwd, project_id, model, provider, created_at, updated_at, turns, est_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title, cwd=excluded.cwd, project_id=excluded.project_id,
         model=excluded.model, provider=excluded.provider,
         updated_at=excluded.updated_at, turns=excluded.turns, est_tokens=excluded.est_tokens`,
    )
    .run(m.id, m.title, m.cwd, m.project_id, m.model, m.provider, m.created_at, m.updated_at, m.turns, m.est_tokens);
}

export function listSessionMeta(limit = 50): SessionMeta[] {
  return getDb()
    .prepare(`SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?`)
    .all(limit) as unknown as SessionMeta[];
}

export function deleteSessionMeta(id: string): void {
  getDb().prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}

// ─── usage ───

export function recordUsage(sessionId: string, model: string, inputTokens: number, outputTokens: number): void {
  getDb()
    .prepare(`INSERT INTO usage (session_id, at, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)`)
    .run(sessionId, new Date().toISOString(), model, inputTokens, outputTokens);
}
