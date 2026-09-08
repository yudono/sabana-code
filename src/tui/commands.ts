// ─── Slash-command TUI: parse + daftar bantuan ───

export interface ParsedCommand {
  name: string;
  args: string[];
}

export function parseCommand(input: string): ParsedCommand | null {
  const t = input.trim();
  if (!t.startsWith("/")) return null;
  const parts = t.slice(1).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return { name: parts[0].toLowerCase(), args: parts.slice(1) };
}

export const COMMAND_LIST: Array<{ name: string; usage: string; desc: string }> = [
  { name: "/help", usage: "/help", desc: "Tampilkan bantuan ini" },
  { name: "/new", usage: "/new", desc: "Mulai session baru" },
  { name: "/sessions", usage: "/sessions", desc: "Daftar semua session tersimpan" },
  { name: "/projects", usage: "/projects", desc: "Daftar project + jumlah session" },
  { name: "/agents", usage: "/agents", desc: "Daftar profil sub-agent kustom" },
  { name: "/agent", usage: "/agent <nama> <tugas>", desc: "Delegasikan tugas ke sub-agent" },
  { name: "/resume", usage: "/resume <id|nomor>", desc: "Lanjutkan session (dukung prefix id)" },
  { name: "/model", usage: "/model [nama]", desc: "Lihat / ganti model" },
  { name: "/provider", usage: "/provider [nama]", desc: "Lihat / ganti provider + uji koneksi" },
  { name: "/login", usage: "/login <provider> <key>", desc: "Simpan API key ke ~/sabana-code/ (global)" },
  { name: "/logout", usage: "/logout [provider]", desc: "Lihat / hapus kredensial tersimpan" },
  { name: "/context", usage: "/context", desc: "Lihat pemakaian context window" },
  { name: "/tools", usage: "/tools", desc: "Daftar tools agent" },
  { name: "/clear", usage: "/clear", desc: "Bersihkan layar (riwayat konteks tetap)" },
  { name: "/quit", usage: "/quit", desc: "Simpan session & keluar (alias /exit)" },
];

export function helpText(): string {
  return ["Perintah tersedia:", ...COMMAND_LIST.map((c) => `  ${c.usage.padEnd(22)} ${c.desc}`)].join("\n");
}
