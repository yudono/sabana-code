// ─── Banner brand TUI: ASCII art "SABANA CODE" ───
// Drawn algorithmically from a 3x5 pixel font (not hand art) so that
// inter-line alignment is GUARANTEED consistent on all monospace terminals.
// Shows big-centered with no chat yet; after chat exists, the small
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
/** All rows equal width (right-padded) to center as one block. */
export const BANNER_LINES: string[] = _raw.map((l) => l.padEnd(_w));

export const BANNER_TAGLINE = "Autonomous coding agent — type a message to start • /help";

// Short tips under the banner (empty state only).
export const BANNER_TIPS: string[] = [
  "• /models — switch model  •  /providers — switch provider",
  "• click a tool row for preview  •  /todo work queue",
];

/** True once conversation exists (user/assistant/tool), not mere info. */
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
