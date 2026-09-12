// ─── Mouse SGR (1006) — left-press clicks tool rows ───
// Terminal sends: ESC [ < Cb ; Cx ; Cy M (press) / m (release).
// Cb & 3 === 0  → left button. Drag (32), wheel (64/65), other buttons handled/ignored per callback.

export const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
export const MOUSE_OFF = "\x1b[?1000l";

export interface MouseClick {
  /** Kolom terminal 1-based. */
  x: number;
  /** Baris terminal 1-based. */
  y: number;
}

export type WheelDir = "up" | "down";

const SGR_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
// A tail that may start an incomplete sequence — hold as remainder.
const TAIL_RE = /\x1b(?:\[<?[\d;]*)?$/;

/**
 * Build a stateful parser: feed it stdin chunks.
 * - onClick: LEFT press (1-based coordinates).
 * - onWheel (optional): trackpad/mouse wheel gestures (cb 64 = up, 65 = down).
 * - onRightClick (optional): RIGHT press (1-based coordinates, e.g. context menus).
 */
export function createMouseParser(
  onClick: (c: MouseClick) => void,
  onWheel?: (dir: WheelDir) => void,
  onRightClick?: (c: MouseClick) => void,
): (chunk: string) => void {
  let buf = "";
  return (chunk: string) => {
    buf += chunk;
    SGR_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    let lastEnd = 0;
    while ((m = SGR_RE.exec(buf))) {
      const cb = parseInt(m[1], 10);
      const trailer = m[4];
      const pos = { x: parseInt(m[2], 10), y: parseInt(m[3], 10) };
      if (trailer === "M" && (cb & 64) !== 0) {
        // Wheel has no meaningful release — each tick = 1 step.
        onWheel?.((cb & 1) !== 0 ? "down" : "up");
      } else if (trailer === "M" && (cb & 3) === 2 && (cb & 64) === 0 && (cb & 32) === 0) {
        onRightClick?.(pos);
      } else if (trailer === "M" && (cb & 3) === 0 && (cb & 64) === 0 && (cb & 32) === 0) {
        onClick(pos);
      }
      lastEnd = m.index + m[0].length;
    }
    const rest = buf.slice(lastEnd);
    // Hold a possibly-incomplete tail, drop the rest.
    const tail = rest.match(TAIL_RE);
    buf = tail ? tail[0].slice(-16) : "";
  };
}

/**
 * Strip leftover mouse sequences from input text (so they never get typed).
 * Handles BOTH forms: complete (`ESC[<0;1;2M`) and orphaned (`[<0;1;2M` —
 * Ink ate the ESC before onChange, exactly the gesture-scroll flood case).
 */
export function stripMouseSequences(s: string): string {
  return s
    .replace(/\x1b\[<\d+;\d+;\d+[mM]/g, "")
    .replace(/\[<\d+;\d+;\d+[mM]/g, "");
}
