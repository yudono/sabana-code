// ─── Kebijakan izin shell: perintah read-only bebas izin, sisanya ditanya ───
// write/read/edit file & tool baca lain TIDAK perlu izin (risk "safe").
// Yang perlu izin hanya eksekusi perintah yang berpotensi berbahaya
// (rm, mkdir, npm, git, ...). Perintah aman seperti cd/ls langsung jalan.
//
// Aturan untuk satu perintah shell:
// - mengandung substitusi (`...` / $(...)) atau redireksi (>/<) → TIDAK aman.
// - dipecah per segmen (&&, ||, ;, |, newline): SEMUA segmen harus aman.
// - kata pertama tiap segmen (abaikan wrapper command/builtin & VAR=x)
//   harus ada di daftar SAFE. sudo/doas → selalu minta izin.

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
  // Lewati wrapper command/builtin dan assignment VAR=nilai
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
