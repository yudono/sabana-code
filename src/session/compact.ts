// ─── Compact: ringkas riwayat jadi satu pesan agar konteks muat ───
// Dipakai manual via /compact dan otomatis saat menyentuh >80% window.
import type { ModelMessage } from "../llm/types.js";

/** Ambang auto-compact (% context window). */
export const AUTO_COMPACT_PCT = 80;

/** Jumlah pesan terakhir yang dipertahankan apa adanya setelah ringkasan. */
export const COMPACT_KEEP_LAST = 6;

const COMPACT_INSTRUCTION = `Kamu adalah peringkas konteks untuk coding agent. Ringkas riwayat percakapan di bawah menjadi rangkuman padat (maks ~400 kata, Bahasa Indonesia boleh campur istilah teknis Inggris).

Wajib mencakup:
1. Tujuan user & status terakhir (selesai / belum, apa yang kurang).
2. Keputusan penting (model, library, pendekatan yang dipilih dan kenapa).
3. File yang dibuat/diubah + perubahan kuncinya.
4. Error/loop yang terjadi + cara mengatasinya (agar tidak diulang).
5. Langkah berikutnya yang direncanakan.

Tulis HANYA rangkuman, tanpa basa-basi pembuka/penutup.`;

function clip(s: string, n: number): string {
  const t = (s || "").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

/** Bangun prompt ringkasan dari transkrip (dipotong agar request-nya sendiri ringan). */
export function buildCompactPrompt(messages: ModelMessage[]): string {
  const body = messages.filter((m) => m.role !== "system");
  const lines = body.map((m) => {
    const tools = m.tool_calls?.length ? ` [tools: ${m.tool_calls.map((t) => t.function.name).join(",")}]` : "";
    return `[${m.role}]${tools}\n${clip(m.content || "", 1200)}`;
  });
  return `${COMPACT_INSTRUCTION}\n\n--- RIWAYAT ---\n${lines.join("\n\n")}`.slice(0, 14_000);
}

export interface CompactApplied {
  messages: ModelMessage[];
  dropped: number;
}

/**
 * Terapkan ringkasan: system[0] + pesan ringkasan + N pesan terakhir.
 * Mencegah tool-result yatim di awal (tanpanya API menolak riwayat).
 */
export function applyCompactSummary(
  messages: ModelMessage[],
  summary: string,
  keepLast = COMPACT_KEEP_LAST,
): CompactApplied {
  const before = messages.length;
  const system = messages.length > 0 && messages[0].role === "system" ? [messages[0]] : [];
  const body = messages.length > 0 && messages[0].role === "system" ? messages.slice(1) : [...messages];
  const tail = body.slice(-keepLast);
  const out: ModelMessage[] = [
    ...system,
    {
      role: "user",
      content: `## RINGKASAN KONTEKS SEBELUMNYA\n${summary.trim()}\n\nLanjutkan pekerjaan dari ringkasan ini.`,
    },
    ...tail,
  ];
  let dropped = before - out.length;
  while (out.length > system.length + 1 && out[system.length + 1]?.role === "tool") {
    out.splice(system.length + 1, 1);
    dropped++;
  }
  return { messages: out, dropped };
}
