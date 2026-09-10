// ─── Banner brand TUI: ASCII art "SABANA CODE" ───
// Digambar algoritmik dari font piksel 3x5 (bukan gambar tangan) sehingga
// alignment antar-baris DIJAMIN konsisten di semua terminal monospace.
// Tampil besar-tengah saat belum ada chat; setelah ada chat, header kecil
// biasa yang dipakai (lihat App.tsx).
import type { HlColor } from "./highlight.js";

export interface BannerSeg {
  text: string;
  color?: HlColor;
  bold?: boolean;
  dim?: boolean;
}

const FONT: Record<string, string[]> = {
  A: ["###", "# #", "###", "# #", "# #"],
  B: ["## ", "# #", "## ", "# #", "## "],
  C: [" ##", "#  ", "#  ", "#  ", " ##"],
  D: ["## ", "# #", "# #", "# #", "## "],
  E: ["###", "#  ", "## ", "#  ", "###"],
  N: ["# #", "###", "###", "# #", "# #"],
  O: [" # ", "# #", "# #", "# #", " # "],
  S: [" ##", "#  ", " # ", "  #", "## "],
};

const PIXEL = "█";

/** Render teks (A-Z + spasi) jadi 5 baris blok. Huruf tak dikenal → kosong. */
export function renderBigText(text: string): string[] {
  const rows = ["", "", "", "", ""];
  const chars = text.toUpperCase().split("");
  chars.forEach((ch, ci) => {
    const glyph = ch === " " ? ["   ", "   ", "   ", "   ", "   "] : FONT[ch] || ["   ", "   ", "   ", "   ", "   "];
    for (let r = 0; r < 5; r++) {
      rows[r] += glyph[r].replace(/#/g, PIXEL).replace(/ /g, " ");
      if (ci < chars.length - 1) rows[r] += " ";
    }
  });
  return rows.map((l) => l.replace(/\s+$/, ""));
}

const _raw = renderBigText("SABANA CODE");
const _w = Math.max(..._raw.map((l) => l.length));
/** Semua baris sama lebar (pad kanan) agar center sebagai satu blok. */
export const BANNER_LINES: string[] = _raw.map((l) => l.padEnd(_w));

export const BANNER_TAGLINE = "Autonomous coding agent — tulis pesan untuk mulai • /help";

// Tips singkat di bawah banner (state kosong saja).
export const BANNER_TIPS: string[] = [
  "• /models — ganti model  •  /providers — ganti provider",
  "• klik baris tool untuk preview  •  /todo antrean kerja",
];

/** true bila sudah ada percakapan (user/assistant/tool), bukan sekadar info. */
export function hasChatItems(items: Array<{ kind: string }>): boolean {
  return items.some((it) => it.kind === "user" || it.kind === "assistant" || it.kind === "tool");
}

/** Banner siap render: judul cyanBold + tagline/tips dim. */
export function bannerSegs(): BannerSeg[][] {
  const out: BannerSeg[][] = BANNER_LINES.map((l) => [{ text: l, color: "cyan", bold: true }]);
  out.push([{ text: "" }]);
  out.push([{ text: BANNER_TAGLINE, dim: true }]);
  for (const t of BANNER_TIPS) out.push([{ text: t, dim: true }]);
  return out;
}
