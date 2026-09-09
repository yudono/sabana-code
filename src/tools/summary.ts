// ─── Ringkasan tool-call untuk tampilan: JANGAN dump isi file/output ───
// Baris panggilan:  "read_file App.tsx", "modified_file App.tsx", "$ npm test"
// Baris hasil:      "(baris 1–50 dari 320)", "(+1.2k)", "(exit 0 · 1.2s)"

export function fmtBytes(n: number): string {
  const a = Math.abs(n);
  if (a < 1000) return `${n}`;
  const v = (n / 1000).toFixed(1).replace(/\.0$/, "");
  if (a < 1_000_000) return `${v}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** +11.2k / -292 / ±0 */
export function fmtSigned(n: number): string {
  if (n > 0) return `+${fmtBytes(n)}`;
  if (n < 0) return `-${fmtBytes(-n)}`;
  return "±0";
}

export function fmtDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function asObj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

/** Satu baris "sedang mengerjakan apa" — tanpa isi file. */
export function summarizeCall(name: string, args: Record<string, unknown>): string {
  const path = str(args.path);
  switch (name) {
    case "read_file": {
      const s = args.startLine;
      const e = args.endLine;
      const range = typeof s === "number" || typeof e === "number" ? `:${s ?? "?"}-${e ?? "?"}` : "";
      return `read_file ${path}${range}`;
    }
    case "write_file":
    case "modified_file":
    case "delete_file":
      return `${name} ${path}`;
    case "shell":
      return `$ ${oneLine(str(args.command), 100) || "(perintah kosong)"}`;
    case "list_directory":
      return `list ${path || "."}`;
    case "glob":
      return `glob ${str(args.pattern)}`;
    case "grep":
    case "web_search": {
      const q = str(args.query);
      const label = name === "grep" ? "grep" : "search";
      return `${label} ${oneLine(q ? `"${q}"` : "", 80)}`.trim();
    }
    case "web_fetch":
      return `fetch ${oneLine(str(args.url), 100)}`;
    default: {
      const first = Object.entries(args).find(([, v]) => typeof v === "string" || typeof v === "number");
      return first ? `${name} ${oneLine(String(first[1]), 80)}` : name;
    }
  }
}

export interface ToolOutcome {
  status: string;
  output: unknown;
  durationMs: number;
}

function errText(output: unknown): string {
  if (typeof output === "string") return output;
  const o = asObj(output);
  const e = o && typeof o.error === "string" ? o.error : JSON.stringify(output);
  return e ?? "error";
}

/** Satu baris hasil: stat diff / exit code / hitungan — tanpa isi. */
export function summarizeResult(name: string, r: ToolOutcome): string | null {
  if (r.status !== "success") return oneLine(errText(r.output).split("\n")[0], 140);
  const o = asObj(r.output);
  if (!o) return null;
  const num = (k: string): number | null => (typeof o[k] === "number" ? (o[k] as number) : null);
  switch (name) {
    case "read_file": {
      const s = num("startLine");
      const e = num("endLine");
      const t = num("totalLines");
      if (s === null) return null;
      return `baris ${s}–${e ?? "?"} dari ${t ?? "?"}`;
    }
    case "write_file": {
      const b = num("bytes");
      const l = num("lines");
      if (b === null) return null;
      return `+${fmtBytes(b)}${l !== null ? `, ${l} baris` : ""}`;
    }
    case "modified_file": {
      const a = num("added");
      const r = num("removed");
      if (a === null || r === null) {
        // Kompatibel output lama berbasis byte.
        const d = num("bytesChanged");
        if (d === null) return null;
        return `(${fmtSigned(d)})`;
      }
      return `(+${a}, -${r})`;
    }
    case "delete_file": {
      return o.directory ? "(direktori dihapus)" : "(dihapus)";
    }
    case "shell": {
      const code = num("exitCode") ?? 0;
      const ms = num("durationMs") ?? r.durationMs;
      return `exit ${code} · ${fmtDuration(ms)}`;
    }
    case "list_directory": {
      const n = num("entries");
      return n === null ? null : `${n} entri`;
    }
    case "glob": {
      const n = num("count");
      return n === null ? null : `${n} file`;
    }
    case "grep": {
      const n = num("count");
      return n === null ? null : `${n} cocok`;
    }
    case "web_search": {
      const res = o.results;
      return Array.isArray(res) ? `${res.length} hasil` : null;
    }
    case "web_fetch": {
      const n = num("length");
      return n === null ? null : `+${fmtBytes(n)} char`;
    }
    default:
      return null;
  }
}
