// ─── Shell approval policy: read-only commands need no approval, the rest ask ───
// File write/read/edit & other read tools need NO approval (risk "safe").
// Only potentially dangerous execution needs approval
// (rm, mkdir, npm, git, ...). Safe commands like cd/ls run directly.
//
// Rules for one shell command:
// - contains substitution (`...` / $(...)) or redirection (>/<) → NOT safe.
// - split per segment (&&, ||, ;, |, newline): ALL segments must be safe.
// - first word of each segment (ignoring command/builtin wrappers & VAR=x)
//   must be on the SAFE list. sudo/doas → always ask.

const SAFE_BASES = new Set([
  "cd", "ls", "pwd", "echo", "printf", "cat", "head", "tail", "wc",
  "less", "more", "which", "type", "whoami", "id", "date", "uname",
  "hostname", "env", "printenv", "dirname", "basename", "realpath",
  "readlink", "df", "du", "free", "uptime", "true", "false", "test",
  "clear", "file", "stat", "tree", "sort", "uniq", "cut", "tr",
  "column", "nl", "grep",
]);

function segmentSafe(seg: string): boolean {
  const words = seg.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  // Skip command/builtin wrappers and VAR=value assignments
  for (;;) {
    const w = words[i];
    if (w === "command" || w === "builtin") {
      i++;
      continue;
    }
    if (w && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i++;
      continue;
    }
    break;
  }
  const base = words[i] || "";
  return SAFE_BASES.has(base);
}

export function isSafeShellCommand(command: string): boolean {
  const cmd = (command || "").trim();
  if (!cmd) return false;
  // Substitusi perintah mengeksekusi kode sewenang-wenang → minta izin.
  if (cmd.includes("`") || cmd.includes("$(")) return false;
  // Redireksi menulis/membaca file → minta izin (lewat tool file saja).
  if (/[<>]/.test(cmd)) return false;
  const segments = cmd.split(/&&|\|\||[;|\n]+/).map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every(segmentSafe);
}
