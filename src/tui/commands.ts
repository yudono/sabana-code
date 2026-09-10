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
  { name: "/skills", usage: "/skills", desc: "Daftar skill kerja yang tersedia" },
  { name: "/skill", usage: "/skill <nama>", desc: "Lihat instruksi penuh satu skill" },
  { name: "/todo", usage: "/todo", desc: "Lihat antrean todo project" },
  { name: "/mcp", usage: "/mcp [reload]", desc: "Status server MCP + tools" },
  { name: "/checkpoint", usage: "/checkpoint [label]", desc: "Simpan titik aman (file + riwayat)" },
  { name: "/checkpoints", usage: "/checkpoints", desc: "Daftar titik aman session ini" },
  { name: "/rewind", usage: "/rewind <id>", desc: "Mundur ke checkpoint (restore file + riwayat)" },
  { name: "/resume", usage: "/resume <id|nomor>", desc: "Lanjutkan session (dukung prefix id)" },
  { name: "/models", usage: "/models [filter|nomor|nama]", desc: "Daftar model live provider + pilih" },
  { name: "/providers", usage: "/providers [use|login ...]", desc: "Kelola multi-provider yang terkonek" },
  { name: "/compact", usage: "/compact", desc: "Padatkan konteks sekarang (auto saat >80%)" },
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

/**
 * Cocokkan nama model persis (case-insensitive) ke daftar live terakhir
 * atau katalog — untuk input manual via `/models <nama>`.
 */
export function matchModelName(arg: string, liveModels: string[], catalogIds: string[]): string | null {
  const lower = arg.trim().toLowerCase();
  if (!lower) return null;
  return (
    liveModels.find((m) => m.toLowerCase() === lower) ??
    catalogIds.find((m) => m.toLowerCase() === lower) ??
    null
  );
}
