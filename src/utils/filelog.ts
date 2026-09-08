// ─── File log harian di ~/sabana-code/logs/ ───
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHome, logsDir } from "../home.js";

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Tulis satu baris log (best-effort, tak pernah throw). */
export function flog(scope: string, message: string): void {
  try {
    ensureHome();
    const line = `${new Date().toISOString()} [${scope}] ${message.replace(/\n/g, " ").slice(0, 2000)}\n`;
    appendFileSync(join(logsDir(), `${today()}.log`), line);
  } catch {
    /* log tak boleh merusak jalan utama */
  }
}
