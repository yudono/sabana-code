// ─── Syntax highlighter mungil untuk preview TUI (tanpa dependensi) ───
// Tokenizer per baris: komentar > string > angka > keyword. Cukup untuk
// pratinjau baca, bukan pengganti tree-sitter.

export type HlColor =
  | "cyan"
  | "green"
  | "yellow"
  | "red"
  | "magenta"
  | "blue"
  | "white"
  | "gray";

export interface HlSeg {
  text: string;
  color?: HlColor;
  bold?: boolean;
  dim?: boolean;
}

export type HlLang = "ts" | "json" | "sh" | "md" | "diff" | "code" | "plain";

const TS_KEYWORDS = new Set(
  "break case catch class const continue debugger default delete do else enum export extends false finally for function if implements import in instanceof interface let new null return super switch this throw true try typeof var void while with yield async await static get set of from as satisfies asserts infer keyof readonly abstract declare namespace module require type union".split(
    " ",
  ),
);

const SH_KEYWORDS = new Set(
  "if then else elif fi for while until do done case esac function return exit export local readonly declare shift break continue in select time coproc".split(
    " ",
  ),
);

const MD_FENCE = /^(\s*)(```|~~~)/;

/** Tebak bahasa dari path file. Diff hanya via pemanggil eksplisit. */
export function detectLang(path: string): Exclude<HlLang, "diff"> {
  const p = path.toLowerCase();
  if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(p)) return "ts";
  if (/\.(json|jsonc|json5)$/.test(p)) return "json";
  if (/\.(sh|bash|zsh|fish)$/.test(p) || /(^|\/)dockerfile(\.|$)/.test(p)) return "sh";
  if (/\.(md|mdx|markdown)$/.test(p)) return "md";
  if (/\.(py|pyw)$/.test(p)) return "code";
  if (/\.(css|scss|less)$/.test(p)) return "code";
  if (/\.(rs|go|java|rb|php|swift|kt|c|h|cpp|hpp|cs|vue|svelte|yaml|yml|toml|xml|html)$/.test(p)) {
    return "code";
  }
  return "plain";
}

interface Rule {
  re: RegExp;
  color?: HlColor;
  bold?: boolean;
  dim?: boolean;
}

// Urutan = prioritas pada posisi yang sama.
const TS_RULES: Rule[] = [
  { re: /\/\/.*$/, color: "gray" },
  { re: /\/\*.*?\*\//, color: "gray" },
  { re: /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`?/, color: "green" },
  { re: /\b\d[\d_]*(?:\.\d+)?\b/, color: "yellow" },
];

const JSON_RULES: Rule[] = [
  { re: /"(?:[^"\\\n]|\\.)*"(\s*:)?/, color: "green" },
  { re: /\b\d[\d_]*(?:\.\d+)?\b/, color: "yellow" },
  { re: /\b(?:true|false|null)\b/, color: "magenta" },
];

const SH_RULES: Rule[] = [
  { re: /#[^\n]*/, color: "gray" },
  { re: /'(?:[^'\n]|\\.)*'|"(?:[^"\n]|\\.)*"?/, color: "green" },
  { re: /\b\d+\b/, color: "yellow" },
];

function highlightLine(line: string, rules: Rule[], keywords: Set<string> | null): HlSeg[] {
  const segs: HlSeg[] = [];
  let rest = line;
  let buf = "";
  const flush = () => {
    if (buf) {
      segs.push({ text: buf });
      buf = "";
    }
  };
  while (rest.length > 0) {
    let best: { index: number; len: number; rule: Rule } | null = null;
    for (const rule of rules) {
      rule.re.lastIndex = 0;
      const m = rule.re.exec(rest);
      if (m && m.index !== undefined && m[0].length > 0) {
        if (!best || m.index < best.index) best = { index: m.index, len: m[0].length, rule };
      }
    }
    if (!best) {
      buf += rest;
      break;
    }
    buf += rest.slice(0, best.index);
    flush();
    const tok = rest.slice(best.index, best.index + best.len);
    rest = rest.slice(best.index + best.len);
    // Kata kunci hanya bila token adalah identifier utuh.
    if (keywords && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(tok) && keywords.has(tok)) {
      segs.push({ text: tok, color: "magenta" });
      continue;
    }
    if (keywords && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(tok) && /^[A-Z]/.test(tok)) {
      segs.push({ text: tok, color: "cyan" });
      continue;
    }
    segs.push({ text: tok, color: best.rule.color, bold: best.rule.bold, dim: best.rule.dim });
  }
  flush();
  // Pecah identifier biasa untuk deteksi keyword/tipe di sisa buffer.
  if (!keywords) return segs;
  const out: HlSeg[] = [];
  for (const s of segs) {
    if (s.color) {
      out.push(s);
      continue;
    }
    const parts = s.text.split(/([A-Za-z_$][A-Za-z0-9_$]*)/g);
    for (const p of parts) {
      if (!p) continue;
      if (keywords.has(p)) out.push({ text: p, color: "magenta" });
      else if (/^[A-Z]/.test(p) && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p)) out.push({ text: p, color: "cyan" });
      else out.push({ text: p });
    }
  }
  return out;
}

function highlightMarkdown(line: string): HlSeg[] {
  const h = /^(#{1,6}\s+)(.*)$/.exec(line);
  if (h) return [{ text: h[1], color: "cyan", bold: true }, { text: h[2], bold: true }];
  // Inline code + bold, sisanya polos.
  const segs: HlSeg[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m.index > last) segs.push({ text: line.slice(last, m.index) });
    const tok = m[0];
    segs.push(
      tok.startsWith("`")
        ? { text: tok, color: "green" }
        : { text: tok.slice(2, -2), bold: true },
    );
    last = m.index + tok.length;
  }
  if (last < line.length) segs.push({ text: line.slice(last) });
  return segs.length > 0 ? segs : [{ text: line }];
}

function highlightDiffLine(line: string): HlSeg[] {
  if (line.startsWith("+++") || line.startsWith("---")) return [{ text: line, bold: true }];
  if (line.startsWith("@@")) return [{ text: line, color: "cyan" }];
  if (line.startsWith("+")) return [{ text: line, color: "green" }];
  if (line.startsWith("-")) return [{ text: line, color: "red" }];
  return [{ text: line, dim: true }];
}

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;

/** Highlight kode → baris-baris segmen. Aman untuk konten besar (dipotong). */
export function highlight(code: string, lang: HlLang): HlSeg[][] {
  const rawLines = code.split("\n");
  const truncated = rawLines.length > MAX_LINES;
  const lines = rawLines.slice(0, MAX_LINES).map((l) => (l.length > MAX_LINE_CHARS ? l.slice(0, MAX_LINE_CHARS) + "…" : l));
  const out = lines.map((line): HlSeg[] => {
    if (line === "") return [{ text: "" }];
    switch (lang) {
      case "diff":
        return highlightDiffLine(line);
      case "md": {
        if (MD_FENCE.test(line)) return [{ text: line, color: "green" }];
        return highlightMarkdown(line);
      }
      case "json":
        return highlightLine(line, JSON_RULES, null);
      case "sh":
        return highlightLine(line, SH_RULES, SH_KEYWORDS);
      case "ts":
        return highlightLine(line, TS_RULES, TS_KEYWORDS);
      case "code":
        return highlightLine(
          line,
          [
            { re: /\/\/.*$|#[^\n]*$/, color: "gray" },
            { re: /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/, color: "green" },
            { re: /\b\d[\d_]*(?:\.\d+)?\b/, color: "yellow" },
          ],
          null,
        );
      case "plain":
      default:
        return [{ text: line }];
    }
  });
  if (truncated) out.push([{ text: `… (${rawLines.length - MAX_LINES} baris disembunyikan)`, dim: true }]);
  return out;
}
