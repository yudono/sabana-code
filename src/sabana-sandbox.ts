// ─── sabana-sandbox: eksekusi perintah terminal dengan akses sandbox ───
// SATU PINTU untuk seluruh tool `shell`: tiap command terminal agent lewat sini.
// Disaring GANDA (double filter):
//   Lapisan 1 — kebijakan statis: pola yang SELALU diblokir. Persetujuan user
//               (y/a) TIDAK bisa meng-override. Contoh: `sabana-sandbox "rm -rf /"`
//               → restrict, `sudo ...` → restrict, `curl X | sh` → restrict.
//   Lapisan 2 — kurungan workspace: semua path (absolut/relatif, termasuk target
//               redireksi) harus di dalam workspace. `cd` dilacak per rantai
//               (&& / ; / ||) sehingga `cd / && rm -rf .` ikut tertangkap.
//
// Model ancaman: agent berjalan sebagai user yang sama — yang dijaga adalah
// kesalahan fatal (hapus root, timpa sistem, eskalasi sudo), BUKAN agent jahat
// (ia memang sudah bisa menulis file). Perintah legal seperti `rm -rf .next`
// atau `npm install` di dalam workspace TETAP jalan (perlu izin user dulu).
import { spawn } from "node:child_process";
import { resolve, basename, dirname } from "node:path";

export interface SandboxVerdict {
  allowed: boolean;
  /** Alasan penolakan (untuk pesan SANDBOX BLOCKED). */
  reason?: string;
}

export interface SandboxRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Terisi bila diblokir analisis statis (tidak dieksekusi sama sekali). */
  blocked?: string;
}

export interface SandboxRunOptions {
  timeoutMs?: number;
  maxOutputChars?: number;
  /** Direktori mulai relatif/absolut (harus di dalam workspace). Default: workspace root. */
  cwd?: string;
}

const MAX_COMMAND_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 50_000;

// Basis perintah yang TIDAK BOLEH jalan walau user menyetujui.
const HARD_DENY_BASES = new Set([
  "sudo", "su", "doas", "runas", // eskalasi privilege
  "mkfs", "fdisk", "parted", "gdisk", // hancurkan disk
  "shutdown", "reboot", "halt", "poweroff", "init",
  "systemctl", "service", "launchctl", // ubah state sistem
]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh"]);
const DOWNLOADERS = new Set(["curl", "wget", "fetch", "aria2c"]);
// Basis destruktif: target `$VAR` yang tak bisa diverifikasi → tolak (takutnya /).
const STRICT_BASES = new Set(["rm", "shred"]);
// Kata yang dilewati sebelum basis asli (wrapper/builtin/pengukur).
const WRAPPERS = new Set(["command", "builtin", "env", "time", "nohup", "setsid", "exec"]);

// Target rm yang SELALU ditolak (tak peduli workspace).
const RM_NUKE = new Set(["/", "/*", "~", "~/*", "$HOME", "${HOME}", "$HOME/*", "${HOME}/*"]);

// ─── Tokenizer sadar-quote ───
interface Token {
  text: string;
}

/** Pecah segmen jadi kata (hormati '...', "...", backslash). Quote dilepas. */
function tokenize(seg: string): Token[] {
  const out: Token[] = [];
  let cur = "";
  let quote: string | null = null;
  let started = false;
  const push = () => {
    if (started) out.push({ text: cur });
    cur = "";
    started = false;
  };
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (quote) {
      started = true;
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < seg.length) cur += seg[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (c === "\\" && i + 1 < seg.length) {
      cur += seg[++i];
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      push();
      continue;
    }
    cur += c;
    started = true;
  }
  push();
  return out;
}

interface Segment {
  text: string;
  /** Pemisah SEBELUM segmen ini: "", "&&", "||", ";", "|", "&", "\n". */
  sep: string;
}

/** Belah perintah per operator terluar (abaikan yang di dalam quote). */
function splitSegments(cmd: string): Segment[] {
  const segs: Segment[] = [];
  let cur = "";
  let quote: string | null = null;
  const flush = (sep: string) => {
    segs.push({ text: cur, sep });
    cur = "";
  };
  let pendingSep = "";
  const emit = (sep: string) => {
    flush(pendingSep);
    pendingSep = sep;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      else if (c === "\\" && i + 1 < cmd.length) cur += cmd[++i];
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "\\" && i + 1 < cmd.length) {
      cur += c + cmd[++i];
      continue;
    }
    if (c === "&" && cmd[i + 1] === "&") {
      emit("&&");
      i++;
      continue;
    }
    if (c === "|" && cmd[i + 1] === "|") {
      emit("||");
      i++;
      continue;
    }
    if (c === ";" || c === "&" || c === "|" || c === "\n") {
      emit(c);
      continue;
    }
    cur += c;
  }
  flush(pendingSep);
  return segs.map((s) => ({ text: s.text.trim(), sep: s.sep })).filter((s) => s.text);
}

/** Basis biner segmen (basename, lewati VAR=x + wrapper). "" bila kosong. */
function baseOf(words: string[]): string {
  let i = 0;
  for (;;) {
    const w = words[i];
    if (w === undefined) return "";
    if (WRAPPERS.has(w)) {
      i++;
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i++;
      continue;
    }
    break;
  }
  const first = words[i] || "";
  return basename(first).toLowerCase();
}

/** Kembalikan kata argumen (tanpa VAR=x dan wrapper depan). */
function argWords(words: string[]): string[] {
  let i = 0;
  for (;;) {
    const w = words[i];
    if (w === undefined) return [];
    if (WRAPPERS.has(w) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i++;
      continue;
    }
    break;
  }
  return words.slice(i + 1);
}

function expandHome(tok: string): string {
  const home = process.env.HOME || "";
  if (tok === "~" || tok.startsWith("~/")) return home + tok.slice(1);
  return tok
    .replace(/\$HOME\b/g, home)
    .replace(/\$\{HOME\}/g, home);
}

function hasOtherVar(tok: string): boolean {
  const t = tok.replace(/\$HOME\b/g, "").replace(/\$\{HOME\}/g, "");
  return t.includes("$");
}

/** Terlihat seperti path? (absolut, ~/.., ./.., ../.., $VAR.., atau mengandung /) */
function looksLikePath(tok: string): boolean {
  if (!tok || tok === "-" || tok === "--") return false;
  if (tok.startsWith("-") && !tok.includes("/")) return false; // flag
  return (
    tok.startsWith("/") ||
    tok.startsWith("~") ||
    tok.startsWith(".") ||
    tok.startsWith("$") ||
    tok.includes("/")
  );
}

/** Direktori statis untuk token berglob: potong di segmen glob pertama. */
function staticDirOf(tok: string): string {
  const parts = tok.split("/");
  const kept: string[] = [];
  for (const p of parts) {
    if (/[*?[\]{}]/.test(p)) break;
    kept.push(p);
  }
  const joined = kept.join("/");
  if (joined === "" || joined === tok) return tok;
  return joined === "" ? "." : joined || ".";
}

function insideWorkspace(resolved: string, workspaceDir: string): boolean {
  return resolved === workspaceDir || resolved.startsWith(workspaceDir + "/");
}

function deny(reason: string): SandboxVerdict {
  return { allowed: false, reason };
}

/**
 * Analisis statis TANPA eksekusi. Mengembalikan { allowed: true } bila lolos
 * kedua lapisan, atau { allowed: false, reason } bila kena restrict.
 */
export function analyzeCommand(command: string, workspaceDir: string, startDir?: string): SandboxVerdict {
  const cmd = (command || "").trim();
  if (!cmd) return deny("perintah kosong");
  if (cmd.length > MAX_COMMAND_CHARS) return deny(`perintah > ${MAX_COMMAND_CHARS} char — pecah jadi langkah kecil`);
  const ws = resolve(workspaceDir);
  const start = startDir ? resolve(ws, startDir) : ws;
  if (!insideWorkspace(start, ws)) return deny(`direktori kerja '${startDir}' keluar workspace — restrict`);

  // ── Pola keras di seluruh teks (termasuk dalam $(...) / backtick) ──
  if (/(^|[^\w]):\(\)\s*\{/.test(cmd)) return deny("fork bomb terdeteksi — restrict");

  // curl|wget ... | sh → eksekusi remote otomatis. Telusuri rantai pipa:
  // stage shell yang menerima pipa dari downloader di kirinya = blokir.
  const segs = splitSegments(cmd);
  const stages: Array<{ base: string }> = segs.map((s) => ({
    base: baseOf(tokenize(s.text).map((t) => t.text)),
  }));
  for (let i = 0; i < stages.length; i++) {
    if (!SHELLS.has(stages[i].base)) continue;
    let j = i - 1;
    while (j >= 0 && segs[j + 1] && segs[j + 1].sep === "|") {
      if (DOWNLOADERS.has(stages[j].base)) {
        return deny(`${stages[j].base} | ${stages[i].base}: eksekusi remote otomatis — restrict. Download dulu, baca isinya, baru jalankan manual.`);
      }
      j--;
    }
  }

  // ── Per segmen: basis keras + redireksi + cd-tracking + kurungan path ──
  let vcwd: string | null = start; // cwd virtual, mulai dari direktori mulai
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si];
    // Catatan: stage pipa (|) berjalan paralel di direktori yang sama —
    // cd di dalam pipa diabaikan (cukup untuk analisis statis).
    const words = tokenize(seg.text).map((t) => t.text);
    if (words.length === 0) continue;
    const base = baseOf(words);
    if (!base) continue;
    if (HARD_DENY_BASES.has(base)) {
      return deny(`'${base}' dilarang sandbox (eskalasi/merusak sistem) — restrict`);
    }

    // cd dilacak agar `cd / && rm -rf .` tertangkap. cd di dalam pipa (|)
    // jalan di subshell → tak merambat, jadi diabaikan di sini.
    if (base === "cd" && seg.sep !== "|") {
      const args = argWords(words);
      const target = args[0];
      if (!target || target === "~") {
        vcwd = process.env.HOME ? resolve(process.env.HOME) : null;
      } else if (target === "-") {
        vcwd = null; // tak diketahui → relatif berikutnya tak terverifikasi
      } else {
        const exp = expandHome(target);
        vcwd = exp.startsWith("/") ? resolve(exp) : vcwd ? resolve(vcwd, exp) : null;
      }
      continue;
    }

    // Heredoc ke shell = skrip inline tak terlihat → tolak.
    if (SHELLS.has(base) && /(^|\s)<<-?\s*\S/.test(seg.text)) {
      return deny(`heredoc ke '${base}' menyembunyikan skrip — restrict. Tulis file via write_file lalu jalankan.`);
    }

    const args = argWords(words);

    // Redireksi: target harus di dalam workspace (kecuali duplikat fd &N).
    for (let k = 0; k < args.length; k++) {
      const w = args[k];
      const m = /^(?:\d+)?(>>?|<\<?)(.*)$/.exec(w);
      if (!m) continue;
      const op = m[1];
      let target = m[2];
      if (!target && k + 1 < args.length) target = args[++k];
      if (!target) continue;
      if (/^&\d*$/.test(target)) continue; // duplikat fd (2>&1) — aman
      if (op.startsWith("<<")) continue; // heredoc delimiter — ditangani di atas
      if (hasOtherVar(target)) return deny(`redireksi ke '${target}': target tak bisa diverifikasi di dalam workspace — restrict`);
      const full = resolve(vcwd || ws, expandHome(staticDirOf(target)));
      if (!insideWorkspace(full, ws)) {
        return deny(`redireksi ke '${target}' keluar workspace (${ws}) — restrict`);
      }
    }

    // rm nuklir eksplisit.
    if (base === "rm" && args.some((a) => RM_NUKE.has(a))) {
      return deny(`'${seg.text.trim().slice(0, 80)}': menghapus root/home — restrict`);
    }

    // Kurungan path untuk semua token mirip-path (kecuali argv0 = binernya sendiri).
    // Untuk basis destruktif (rm/shred), SEMUA arg non-flag adalah path —
    // nama relatif polos seperti `app` pun harus terverifikasi.
    const isStrict = STRICT_BASES.has(base);
    let sawTarget = false;
    for (const tok of args) {
      if (tok === "&" || /^\d+$/.test(tok)) continue;
      const isFlag = tok.startsWith("-") && !tok.includes("/");
      if (isFlag) continue;
      if (!looksLikePath(tok) && !isStrict) continue;
      sawTarget = true;
      if (hasOtherVar(tok)) {
        if (isStrict) {
          return deny(`'${base} ${tok}': target mengandung variabel tak dikenal — tak bisa dipastikan di dalam workspace. Tulis path eksplisit.`);
        }
        continue; // non-destruktif + sudah disetujui user → lewat
      }
      const dirPart = staticDirOf(expandHome(tok));
      const full = dirPart.startsWith("/") ? resolve(dirPart) : resolve(vcwd || ws, dirPart);
      if (!insideWorkspace(full, ws)) {
        if (STRICT_BASES.has(base)) {
          return deny(`'${base} ${tok}' keluar workspace (${ws}) — restrict`);
        }
        return deny(`path '${tok}' keluar workspace (${ws}) — restrict. Kerjakan di dalam workspace.`);
      }
    }
    // rm/shred tanpa target path terverifikasi = pola berbahaya/tak jelas → tolak.
    if (isStrict && !sawTarget) {
      return deny(`'${base}' tanpa target di dalam workspace — restrict. Tulis path eksplisit.`);
    }
  }

  return { allowed: true };
}

/**
 * Eksekusi via sabana-sandbox: analisis dulu, baru jalan dengan cwd=workspace,
 * timeout bunuh, dan output dibatasi. TIDAK PERNAH melempar untuk blocked —
 * kembalikan { blocked } agar caller menampilkan SANDBOX BLOCKED.
 */
export async function runSandboxed(
  command: string,
  workspaceDir: string,
  opts?: SandboxRunOptions,
): Promise<SandboxRunResult> {
  const ws = resolve(workspaceDir);
  const start = opts?.cwd ? resolve(ws, opts.cwd) : ws;
  if (!insideWorkspace(start, ws)) {
    return { exitCode: 1, stdout: "", stderr: "", durationMs: 0, blocked: `direktori kerja '${opts?.cwd}' keluar workspace — restrict` };
  }
  const verdict = analyzeCommand(command, workspaceDir, opts?.cwd);
  if (!verdict.allowed) {
    return { exitCode: 1, stdout: "", stderr: "", durationMs: 0, blocked: verdict.reason || "restrict" };
  }
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxChars = opts?.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
  // Samarkan perintah `cd sandbox && ...` warisan (pola lama) — sandbox kini implisit.
  const cmd = command
    .replace(/^\s*cd\s+sandbox\s*(?:&&|;)?\s*/, "")
    .replace(/\bsandbox\//g, "./");
  const startTime = Date.now();
  return new Promise((resolveP) => {
    const child = spawn("sh", ["-c", cmd], {
      cwd: start,
      env: { ...process.env, CI: "true", npm_config_yes: "true" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    const cap = (chunk: string, which: "out" | "err") => {
      const cur = which === "out" ? stdout : stderr;
      if (cur.length >= maxChars) {
        truncated = true;
        return;
      }
      const add = chunk.slice(0, maxChars - cur.length);
      if (which === "out") stdout += add;
      else stderr += add;
      if (chunk.length > add.length) truncated = true;
    };
    child.stdout?.on("data", (d: Buffer) => cap(d.toString("utf-8"), "out"));
    child.stderr?.on("data", (d: Buffer) => cap(d.toString("utf-8"), "err"));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* abaikan */
      }
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolveP({ exitCode: 1, stdout, stderr: (stderr + (stderr ? "\n" : "") + (e as Error).message).slice(0, maxChars), durationMs: Date.now() - startTime });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const tail = truncated ? `\n... [output dipotong, maks ${maxChars} char]` : "";
      const timedOut = signal === "SIGKILL";
      resolveP({
        exitCode: timedOut ? 124 : (code ?? 1),
        stdout: (stdout + (truncated ? tail : "")).slice(0, maxChars + tail.length),
        stderr: timedOut ? `timed out setelah ${timeoutMs}ms` : stderr,
        durationMs: Date.now() - startTime,
      });
    });
  });
}
