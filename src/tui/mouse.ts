// ─── Mouse SGR (1006) — tekan tombol kiri untuk klik baris tool ───
// Terminal mengirim: ESC [ < Cb ; Cx ; Cy M (tekan) / m (lepas).
// Cb & 3 === 0  → tombol kiri. Abaikan drag (32), wheel (64/65), tombol lain.

export const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1000l";

export interface MouseClick {
  /** Kolom terminal 1-based. */
  x: number;
  /** Baris terminal 1-based. */
  y: number;
}

const SGR_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
// Ekor yang mungkin awal sequence belum lengkap — tahan sebagai sisa.
const TAIL_RE = /\x1b(?:\[<?[\d;]*)?$/;

/** Buat parser stateful: panggil per chunk stdin, kembalikan klik kiri-tekan. */
export function createMouseParser(onClick: (c: MouseClick) => void): (chunk: string) => void {
  let buf = "";
  return (chunk: string) => {
    buf += chunk;
    SGR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let lastEnd = 0;
    while ((m = SGR_RE.exec(buf))) {
      const cb = parseInt(m[1], 10);
      const trailer = m[4];
      if (trailer === "M" && (cb & 3) === 0 && (cb & 64) === 0 && (cb & 32) === 0) {
        onClick({ x: parseInt(m[2], 10), y: parseInt(m[3], 10) });
      }
      lastEnd = m.index + m[0].length;
    }
    const rest = buf.slice(lastEnd);
    // Simpan kemungkinan ekor tak lengkap, buang sisanya.
    const tail = rest.match(TAIL_RE);
    buf = tail ? tail[0].slice(-16) : "";
  };
}

/** Saring sisa sequence mouse dari teks input (agar tak mengetik sampah). */
export function stripMouseSequences(s: string): string {
  return s.replace(/\x1b\[<\d+;\d+;\d+[mM]/g, "");
}
