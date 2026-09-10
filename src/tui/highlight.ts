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

export type HlLang = "ts" | "json" | "sh" | "md" | "diff" | "py" | "go" | "rust" | "yaml" | "html" | "css" | "sql" | "code" | "plain";

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

const PY_KEYWORDS = new Set(
  "False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case".split(
    " ",
  ),
);

const GO_KEYWORDS = new Set(
  "break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var nil true false iota".split(
    " ",
  ),
);

const RUST_KEYWORDS = new Set(
  "as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while async await dyn".split(
    " ",
  ),
);

const MD_FENCE = /^(\s*)(```|~~~)/;

/** Tebak bahasa dari path file. Diff hanya via pemanggil eksplisit. */
export function detectLang(path: string): Exclude<HlLang, "diff"> {
  const p = path.toLowerCase();
  const base = p.split("/").pop() || p;
  // Nama file khusus tanpa ekstensi.
  if (/^(dockerfile|containerfile)([.:]|$)/.test(base) || base === "makefile" || base === "gnumakefile") return "sh";
  if (/^.*\b(docker-compose|compose)\.ya?ml$/.test(base)) return "yaml";
  if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(p)) return "ts";
  if (/\.(json|jsonc|json5|webmanifest)$/.test(p)) return "json";
  if (/\.(sh|bash|zsh|fish|ksh)$/.test(p)) return "sh";
  if (/\.(md|mdx|markdown)$/.test(p)) return "md";
  if (/\.(py|pyw|pyi)$/.test(p)) return "py";
  if (/\.(go)$/.test(p)) return "go";
  if (/\.(rs)$/.test(p)) return "rust";
  if (/\.(yaml|yml|toml|ini|cfg|conf|env)$/.test(p)) return "yaml";
  if (/\.(html|htm|xhtml|vue|svelte|astro)$/.test(p)) return "html";
  if (/\.(css|scss|less)$/.test(p)) return "css";
  if (/\.(sql)$/.test(p)) return "sql";
  if (/\.(c|h|cc|cpp|hpp|cxx|cs|java|kt|kts|rb|php|swift|scala|lua|pl|r|dart|ex|exs|erl|hs)$/.test(p)) {
    return "code";
  }
  if (/\.(xml|svg|rss|atom|plist|iml|csproj)$/.test(p)) return "html";
  if (/\.(txt|log|text)$/.test(p)) return "plain";
  return "plain";
}

/**
 * Tebakan konten untuk file tanpa ekstensi dikenali (skrip tanpa ekstensi,
 * dotfiles, dsb). Path tetap menang bila sudah spesifik (bukan plain/code).
 */
export function detectLangFromContent(path: string, content: string): Exclude<HlLang, "diff"> {
  const byPath = detectLang(path);
  if (byPath !== "plain" && byPath !== "code") return byPath;
  const head = content.split("\n").slice(0, 5).join("\n");
  const shebang = /^#!\s*(.+)$/.exec(head.split("\n")[0] || "");
  if (shebang) {
    // Dukung bentuk `/usr/bin/env python3` (interpreter = token setelah env).
    const toks = shebang[1].trim().split(/\s+/).filter((t) => !t.startsWith("-"));
    let bin = (toks[0] || "").split("/").pop() || "";
    if ((bin === "env" || bin === "busybox") && toks[1]) bin = toks[1].split("/").pop() || "";
    bin = bin.toLowerCase();
    if (/^(bash|sh|dash|zsh|fish|ksh)$/.test(bin)) return "sh";
    if (/^python/.test(bin)) return "py";
    if (/^(node|bun|deno|ts-node|tsx)$/.test(bin)) return "ts";
    if (/^(ruby|perl|php|lua)$/.test(bin)) return "code";
    if (/^go$/.test(bin)) return "go";
  }
  const t = head.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      JSON.parse(content.slice(0, 4000));
      return "json";
    } catch {
      /* bukan JSON */
    }
  }
  if (/^---\s*\n(\s*\w[\w-]*\s*:)/.test(head)) return "yaml";
  if (/^\s*<(html|!doctype|xml|svg)/i.test(t)) return "html";
  if (/^\s*(import|from|def |class |if __name__)/m.test(head) && /:\s*$/.test(head.split("\n")[0] || "")) return "py";
  return byPath;
}

/** Buang ANSI escape (warna shell) agar pratinjau terminal bersih. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\r/g, "");
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
      case "py":
        return highlightLine(
          line,
          [
            { re: /#[^\n]*/, color: "gray" },
            { re: /f?'(?:[^'\\\n]|\\.)*'|f?"(?:[^"\\\n]|\\.)*"|"""[\s\S]*?"""|'''[\s\S]*?'''/, color: "green" },
            { re: /\b\d[\d_]*(?:\.\d+)?\b/, color: "yellow" },
          ],
          PY_KEYWORDS,
        );
      case "go":
      case "rust":
        return highlightLine(
          line,
          [
            { re: /\/\/.*$/, color: "gray" },
            { re: /\/\*.*?\*\//, color: "gray" },
            { re: /'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`?/, color: "green" },
            { re: /\b\d[\d_]*(?:\.\d+)?\b/, color: "yellow" },
          ],
          lang === "go" ? GO_KEYWORDS : RUST_KEYWORDS,
        );
      case "yaml":
        return highlightLine(
          line,
          [
            { re: /#[^\n]*/, color: "gray" },
            { re: /^(\s*)([\w.-]+)(\s*:)/, color: "cyan" },
            { re: /'(?:[^'\n]|\\.)*'|"(?:[^"\n]|\\.)*"?/, color: "green" },
            { re: /\b(?:true|false|null|yes|no|on|off)\b/, color: "magenta" },
          ],
          null,
        );
      case "html":
        return highlightLine(
          line,
          [
            { re: /<!--.*?-->/, color: "gray" },
            { re: /<\/?[a-zA-Z][^>]*?>/, color: "cyan" },
            { re: /"(?:[^"\n]|\\.)*"|'(?:[^'\n]|\\.)*'/, color: "green" },
          ],
          null,
        );
      case "css":
        return highlightLine(
          line,
          [
            { re: /\/\*.*?\*\//, color: "gray" },
            { re: /#[0-9a-fA-F]{3,8}\b/, color: "yellow" },
            { re: /\b\d+(?:\.\d+)?(?:px|em|rem|%|vh|vw|s|ms)?\b/, color: "yellow" },
            { re: /"(?:[^"\n]|\\.)*"|'(?:[^'\n]|\\.)*'/, color: "green" },
          ],
          null,
        );
      case "sql":
        return highlightLine(
          line,
          [
            { re: /--.*$/, color: "gray" },
            { re: /'(?:[^'\\]|\\.)*'?/, color: "green" },
            { re: /\b\d+(?:\.\d+)?\b/, color: "yellow" },
          ],
          new Set(
            "select from where join left right inner outer on group by order having limit offset insert into values update set delete create table alter drop index view as and or not null primary key foreign references distinct count sum avg min max".split(" "),
          ),
        );
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
