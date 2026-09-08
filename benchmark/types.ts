// ─── Tipe task benchmark ala Terminal-Bench ───
import type { MockStep } from "../src/llm/mock.js";

export interface BenchmarkTask {
  /** id unik, mis. "fix-bug" */
  id: string;
  title: string;
  /** Instruksi yang diberikan ke agent (seperti SWE-bench problem statement) */
  prompt: string;
  /** Siapkan workspace sebelum agent jalan (tulis file buggy, dll.) */
  setup?: (ws: string) => Promise<void>;
  /** Verifikasi hasil. Throw bila gagal (seperti FAIL_TO_PASS tests). */
  verify: (ws: string) => Promise<void>;
  /** Skrip deterministik untuk provider mock (tanpa LLM key). */
  mockPlan: MockStep[];
  /** Batas waktu per task (default 120000) */
  timeoutMs?: number;
}
