// ─── sabana-sandbox: sandboxed terminal command execution ───
// SINGLE GATE for the whole `shell` tool: every agent terminal command passes here.
// DOUBLE filtered:
//   Layer 1 — static policy: patterns that are ALWAYS blocked. User approval
//               (y/a) CANNOT override. Example: `sabana-sandbox "rm -rf /"`
//               → restrict, `sudo ...` → restrict, `curl X | sh` → restrict.
//   Layer 2 — workspace jail: all paths (absolute/relative, incl. redirect
//               targets) must stay inside the workspace. `cd` is tracked per chain
//               (&& / ; / ||) so `cd / && rm -rf .` is caught too.
//
// Threat model: the agent runs as the same user — what is guarded against is
// fatal mistakes (wiping root, overwriting the system, sudo escalation), NOT a
// malicious agent (it can already write files). Legal commands like `rm -rf .next`
// or `npm install` inside the workspace STILL run (user approval first).
import { spawn } from "node:child_process";
import { resolve, basename, dirname } from "node:path";

export interface SandboxVerdict {
  allowed: boolean;
  /** Refusal reason (for SANDBOX BLOCKED messages). */
  reason?: string;
}

export interface SandboxRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** Set when blocked by static analysis (never executed at all). */
  blocked?: string;
}

export interface SandboxRunOptions {
  timeoutMs?: number;
  maxOutputChars?: number;
  /** Relative/absolute start directory (must stay inside the workspace). Default: workspace root. */
  cwd?: string;
}

const MAX_COMMAND_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_OUTPUT = 50_000;

// Command bases that must NEVER run even with user approval.
const HARD_DENY_BASES = new Set([
  "sudo", "su", "doas", "runas", // eskalasi privilege
  "mkfs", "fdisk", "parted", "gdisk", // hancurkan disk
  "shutdown", "reboot", "halt", "poweroff", "init",
  "systemctl", "service", "launchctl", // ubah state sistem
]);

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh"]);
const DOWNLOADERS = new Set(["curl", "wget", "fetch", "aria2c"]);
// Destructive bases: `$VAR` targets that cannot verify → refuse (could be /).
const STRICT_BASES = new Set(["rm", "shred"]);
// Words skipped before the real base (wrapper/builtin/measurer).
const WRAPPERS = new Set(["command", "builtin", "env", "time", "nohup", "setsid", "exec"]);

// rm targets that are ALWAYS refused (regardless of workspace).
const RM_NUKE = new Set(["/", "/*", "~", "~/*", "$HOME", "${HOME}", "$HOME/*", "${HOME}/*"]);

// ─── Quote-aware tokenizer ───
interface Token {
  text: string;
}

/** Split a segment into words (respecting '...', "...", backslash). Quotes stripped. */
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

/** Split a command on top-level operators (ignoring quoted ones). */
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

/** Segment binary base (basename, skipping VAR=x + wrappers). "" when empty. */
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

/** Return argument words (without VAR=x and leading wrappers). */
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

/** Looks like a path? (absolute, ~/.., ./.., ../.., $VAR.., or contains /) */
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

/** Static directory for glob tokens: cut at the first glob segment. */
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
 * Static analysis WITHOUT execution. Returns { allowed: true } when passing
 * both layers, or { allowed: false, reason } when restricted.
 */
export function analyzeCommand(command: string, workspaceDir: string, startDir?: string): SandboxVerdict {
  const cmd = (command || "").trim();
  if (!cmd) return deny("empty command");
  if (cmd.length > MAX_COMMAND_CHARS) return deny(`command > ${MAX_COMMAND_CHARS} chars — split into smaller steps`);
  const ws = resolve(workspaceDir);
  const start = startDir ? resolve(ws, startDir) : ws;
  if (!insideWorkspace(start, ws)) return deny(`working directory '${startDir}' is outside the workspace — restrict`);

  // ── Hard patterns across the whole text (incl. inside $(...) / backticks) ──
  if (/(^|[^\w]):\(\)\s*\{/.test(cmd)) return deny("fork bomb detected — restrict");

  // curl|wget ... | sh → automatic remote execution. Walk the pipe chain:
  // a shell stage piped from a downloader on its left = block.
  const segs = splitSegments(cmd);
  const stages: Array<{ base: string }> = segs.map((s) => ({
    base: baseOf(tokenize(s.text).map((t) => t.text)),
  }));
  for (let i = 0; i < stages.length; i++) {
    if (!SHELLS.has(stages[i].base)) continue;
    let j = i - 1;
    while (j >= 0 && segs[j + 1] && segs[j + 1].sep === "|") {
      if (DOWNLOADERS.has(stages[j].base)) {
        return deny(`${stages[j].base} | ${stages[i].base}: remote code execution — restrict. Download first, read it, then run manually.`);
      }
      j--;
    }
  }

  // ── Per segmen: basis keras + redireksi + cd-tracking + kurungan path ──
  let vcwd: string | null = start; // virtual cwd, starts at the start directory
  for (let si = 0; si < segs.length; si++) {
    const seg = segs[si];
    // Note: pipe (|) stages run in parallel in the same directory —
    // cd inside pipes is ignored (good enough for static analysis).
    const words = tokenize(seg.text).map((t) => t.text);
    if (words.length === 0) continue;
    const base = baseOf(words);
    if (!base) continue;
    if (HARD_DENY_BASES.has(base)) {
      return deny(`'${base}' is forbidden by the sandbox (escalation/system damage) — restrict`);
    }

    // cd is tracked so `cd / && rm -rf .` is caught. cd inside pipes (|)
    // runs in a subshell → does not propagate, so ignored here.
    if (base === "cd" && seg.sep !== "|") {
      const args = argWords(words);
      const target = args[0];
      if (!target || target === "~") {
        vcwd = process.env.HOME ? resolve(process.env.HOME) : null;
      } else if (target === "-") {
        vcwd = null; // unknown → following relatives unverifiable
      } else {
        const exp = expandHome(target);
        vcwd = exp.startsWith("/") ? resolve(exp) : vcwd ? resolve(vcwd, exp) : null;
      }
      continue;
    }

    // Heredoc into a shell = invisible inline script → refuse.
    if (SHELLS.has(base) && /(^|\s)<<-?\s*\S/.test(seg.text)) {
      return deny(`heredoc into '${base}' hides a script — restrict. Write a file via write_file, then run it.`);
    }

    const args = argWords(words);

    // Redirects: target must stay inside the workspace (except &N fd dups).
    for (let k = 0; k < args.length; k++) {
      const w = args[k];
      const m = /^(?:\d+)?(>>?|<\<?)(.*)$/.exec(w);
      if (!m) continue;
      const op = m[1];
      let target = m[2];
      if (!target && k + 1 < args.length) target = args[++k];
      if (!target) continue;
      if (/^&\d*$/.test(target)) continue; // fd dup (2>&1) — safe
      if (op.startsWith("<<")) continue; // heredoc delimiter — handled above
      if (hasOtherVar(target)) return deny(`redirect to '${target}': target cannot be verified inside the workspace — restrict`);
      const full = resolve(vcwd || ws, expandHome(staticDirOf(target)));
      if (!insideWorkspace(full, ws)) {
        return deny(`redirect to '${target}' outside the workspace (${ws}) — restrict`);
      }
    }

    // Explicit nuclear rm.
    if (base === "rm" && args.some((a) => RM_NUKE.has(a))) {
      return deny(`'${seg.text.trim().slice(0, 80)}': deletes root/home — restrict`);
    }

    // Path jail for all path-like tokens (except argv0 = the binary itself).
    // For destructive bases (rm/shred), ALL non-flag args are paths —
    // even bare relative names like `app` must verify.
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
          return deny(`'${base} ${tok}': target contains an unknown variable — cannot verify it is inside the workspace. Write an explicit path.`);
        }
        continue; // non-destructive + already user-approved → pass
      }
      const dirPart = staticDirOf(expandHome(tok));
      const full = dirPart.startsWith("/") ? resolve(dirPart) : resolve(vcwd || ws, dirPart);
      if (!insideWorkspace(full, ws)) {
        if (STRICT_BASES.has(base)) {
          return deny(`'${base} ${tok}' is outside the workspace (${ws}) — restrict`);
        }
        return deny(`path '${tok}' is outside the workspace (${ws}) — restrict. Work inside the workspace.`);
      }
    }
    // rm/shred with no verified path target = dangerous/unclear pattern → refuse.
    if (isStrict && !sawTarget) {
      return deny(`'${base}' has no target inside the workspace — restrict. Write an explicit path.`);
    }
  }

  return { allowed: true };
}

/**
 * Execute via sabana-sandbox: analyze first, then run with cwd=workspace,
 * kill-on-timeout, and capped output. NEVER throw for blocked —
 * return { blocked } so the caller shows SANDBOX BLOCKED.
 */
export async function runSandboxed(
  command: string,
  workspaceDir: string,
  opts?: SandboxRunOptions,
): Promise<SandboxRunResult> {
  const ws = resolve(workspaceDir);
  const start = opts?.cwd ? resolve(ws, opts.cwd) : ws;
  if (!insideWorkspace(start, ws)) {
    return { exitCode: 1, stdout: "", stderr: "", durationMs: 0, blocked: `working directory '${opts?.cwd}' is outside the workspace — restrict` };
  }
  const verdict = analyzeCommand(command, workspaceDir, opts?.cwd);
  if (!verdict.allowed) {
    return { exitCode: 1, stdout: "", stderr: "", durationMs: 0, blocked: verdict.reason || "restrict" };
  }
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxChars = opts?.maxOutputChars ?? DEFAULT_MAX_OUTPUT;
  // Mask legacy `cd sandbox && ...` commands (old pattern) — sandbox is implicit now.
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
      const tail = truncated ? `\n... [output truncated, max ${maxChars} chars]` : "";
      const timedOut = signal === "SIGKILL";
      resolveP({
        exitCode: timedOut ? 124 : (code ?? 1),
        stdout: (stdout + (truncated ? tail : "")).slice(0, maxChars + tail.length),
        stderr: timedOut ? `timed out after ${timeoutMs}ms` : stderr,
        durationMs: Date.now() - startTime,
      });
    });
  });
}
