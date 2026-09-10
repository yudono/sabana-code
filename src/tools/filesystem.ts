// ─── Filesystem tools — ported from sabana-dev tools/built-in/{read,write,tools}.ts ───
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import type { ToolDefinition } from "./types.js";
import { safePath } from "./sandbox.js";
import { isSensitivePath } from "../utils/guardrails.js";

// ─── read_file ───
export const readFileTool: ToolDefinition = {
  name: "read_file",
  description: "Read file contents. Returns line-numbered content. Supports line ranges for large files.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to workspace root" },
      startLine: { type: "number", description: "Start line (1-indexed)" },
      endLine: { type: "number", description: "End line (inclusive)" },
      maxLines: { type: "number", description: "Max lines (default 500)" },
    },
    required: ["path"],
  },
  permissions: { requiresPermission: false },
  timeout: 10_000,
  riskLevel: "safe",
};

export function readFileHandler(workspaceDir: string) {
  return async (args: Record<string, unknown>) => {
    const path = args.path as string;
    const sensitive = isSensitivePath(path);
    if (sensitive) return { error: `Refusing to read sensitive file (${sensitive}): ${path}`, denied: true };
    const full = safePath(workspaceDir, path);
    if (!full) return { error: `Path escapes workspace: ${path}`, denied: true };
    if (!existsSync(full)) return { error: `File not found: ${path}`, exists: false };
    const stat = statSync(full);
    if (stat.isDirectory()) return { error: `Is a directory: ${path}`, isDirectory: true };
    const buf = Buffer.alloc(512);
    const fd = openSync(full, "r");
    const n = readSync(fd, buf, 0, 512, 0);
    closeSync(fd);
    if (buf.slice(0, n).includes(0)) return { error: `Binary file: ${path}`, binary: true };
    const content = readFileSync(full, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(1, (args.startLine as number) || 1);
    const maxLines = (args.maxLines as number) || 500;
    const end = Math.min(lines.length, (args.endLine as number) || start + maxLines - 1);
    return {
      path,
      startLine: start,
      endLine: end,
      totalLines: lines.length,
      truncated: end - start + 1 < lines.length,
      hash: createHash("md5").update(content).digest("hex"),
      content: lines.slice(start - 1, end).map((l, i) => `${start + i}: ${l}`).join("\n"),
    };
  };
}

// ─── write_file ───
export const writeFileTool: ToolDefinition = {
  name: "write_file",
  description: "Write a new file / overwrite an entire file. Creates parent folders automatically. For small edits use modified_file.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to workspace root" },
      content: { type: "string", description: "Complete file contents" },
    },
    required: ["path", "content"],
  },
  permissions: { requiresPermission: false },
  timeout: 15_000,
  riskLevel: "safe",
};

export function writeFileHandler(workspaceDir: string) {
  return async (args: Record<string, unknown>) => {
    const path = args.path as string;
    const content = args.content as string;
    const full = safePath(workspaceDir, path);
    if (!full) return { error: `Path escapes workspace: ${path}`, denied: true };
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content, "utf-8");
    return { path, written: true, bytes: content.length, lines: content.split("\n").length };
  };
}

// ─── modified_file ───
export const modifiedFileTool: ToolDefinition = {
  name: "modified_file",
  description:
    "Targeted edits with exact search-and-replace. Returns a unified diff (+/-). Fails when search is missing or ambiguous.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      search: { type: "string", description: "Exact string to find" },
      replace: { type: "string", description: "Replacement" },
    },
    required: ["path", "search", "replace"],
  },
  permissions: { requiresPermission: false },
  timeout: 10_000,
  riskLevel: "safe",
};

export interface FileDiff {
  added: number;
  removed: number;
  diff: string;
}

/**
 * Simple unified diff for ONE search→replace hunk.
 * Prefix/suffix yang sama dipangkas; konteks 3 baris di tiap sisi hunk.
 */
export function buildDiff(path: string, oldContent: string, newContent: string, context = 3): FileDiff {
  const a = oldContent.split("\n");
  const b = newContent.split("\n");
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf++;
  }
  const aStart = Math.max(0, pre - context);
  const bStart = Math.max(0, pre - context);
  const aEnd = Math.min(a.length, a.length - suf + context);
  const bEnd = Math.min(b.length, b.length - suf + context);
  const out: string[] = [
    `--- ${path}`,
    `+++ ${path}`,
    `@@ -${aStart + 1},${aEnd - aStart} +${bStart + 1},${bEnd - bStart} @@`,
  ];
  // Upper context: identical lines on both sides.
  for (let i = aStart; i < pre; i++) out.push(` ${a[i]}`);
  const removed = a.slice(pre, a.length - suf);
  const added = b.slice(pre, b.length - suf);
  for (const l of removed) out.push(`-${l}`);
  for (const l of added) out.push(`+${l}`);
  for (let i = a.length - suf; i < aEnd; i++) out.push(` ${a[i]}`);
  return { added: added.length, removed: removed.length, diff: out.join("\n") };
}

export function modifiedFileHandler(workspaceDir: string) {
  return async (args: Record<string, unknown>) => {
    const path = args.path as string;
    const full = safePath(workspaceDir, path);
    if (!full) return { error: `Path escapes workspace: ${path}`, denied: true };
    if (!existsSync(full)) return { error: `File not found: ${path}` };
    const content = readFileSync(full, "utf-8");
    const search = args.search as string;
    const replace = args.replace as string;
    const count = content.split(search).length - 1;
    if (count === 0) return { error: `Search string not found in ${path}` };
    if (count > 1) return { error: `Search string matches ${count}x — provide a longer context` };
    const next = content.replace(search, replace);
    writeFileSync(full, next, "utf-8");
    const { added, removed, diff } = buildDiff(path, content, next);
    return { path, edited: true, bytesChanged: next.length - content.length, added, removed, diff };
  };
}

// ─── delete_file ───
export const deleteFileTool: ToolDefinition = {
  name: "delete_file",
  description: "Delete a file or EMPTY directory inside the workspace. Refuses non-empty directories.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to workspace root" },
    },
    required: ["path"],
  },
  permissions: { requiresPermission: false },
  timeout: 10_000,
  riskLevel: "safe",
};

export function deleteFileHandler(workspaceDir: string) {
  return async (args: Record<string, unknown>) => {
    const path = args.path as string;
    const full = safePath(workspaceDir, path);
    if (!full) return { error: `Path escapes workspace: ${path}`, denied: true };
    if (!existsSync(full)) return { error: `File not found: ${path}` };
    const stat = statSync(full);
    if (stat.isDirectory()) {
      const entries = readdirSync(full);
      if (entries.length > 0) {
        return { error: `Refusing to delete non-empty directory: ${path} (${entries.length} entries)` };
      }
      rmSync(full, { recursive: false });
      return { path, deleted: true, directory: true };
    }
    rmSync(full);
    return { path, deleted: true, directory: false };
  };
}

// ─── list_directory ───
export const listDirectoryTool: ToolDefinition = {
  name: "list_directory",
  description: "List files & subdirectories up to a given depth.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Relative directory (default: root)" },
      maxDepth: { type: "number" },
    },
  },
  permissions: { requiresPermission: false },
  timeout: 10_000,
  riskLevel: "safe",
};

const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".cache", ".next", "coverage"]);

export function listDirectoryHandler(workspaceDir: string) {
  return async (args: Record<string, unknown>) => {
    const raw = (args.path as string) || ".";
    const target = safePath(workspaceDir, raw);
    if (!target) return { error: `Path escapes workspace: ${raw}`, denied: true };
    const maxDepth = (args.maxDepth as number) || 2;
    const walk = (dir: string, depth: number, prefix: string): string => {
      if (depth > maxDepth) return "";
      let out = "";
      try {
        const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        for (const e of entries) {
          if (IGNORE.has(e.name)) continue;
          const rel = prefix ? `${prefix}/${e.name}` : e.name;
          if (e.isDirectory()) {
            out += `${rel}/\n` + walk(join(dir, e.name), depth + 1, rel);
          } else out += `${rel}\n`;
        }
      } catch {
        /* skip */
      }
      return out;
    };
    const listing = walk(target, 0, "");
    return { path: raw, listing, entries: listing.split("\n").filter(Boolean).length };
  };
}

// ─── glob ───
export const globTool: ToolDefinition = {
  name: "glob",
  description: "Find files with a simple glob pattern (e.g. **/*.ts).",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      maxResults: { type: "number" },
    },
    required: ["pattern"],
  },
  permissions: { requiresPermission: false },
  timeout: 15_000,
  riskLevel: "safe",
};

function matchGlob(pattern: string, p: string): boolean {
  const rx = pattern
    .replace(/\./g, "\\.")
    .replace(/\*\*/g, "{{GS}}")
    .replace(/\*/g, "[^/]*")
    .replace(/\{\{GS\}\}/g, ".*");
  return new RegExp(`^${rx}$`).test(p);
}

export function globHandler(workspaceDir: string) {
  return async (args: Record<string, unknown>) => {
    const pattern = args.pattern as string;
    const dir = safePath(workspaceDir, (args.path as string) || ".");
    if (!dir) return { error: "Path escapes workspace", denied: true };
    const max = (args.maxResults as number) || 100;
    const out: string[] = [];
    const walk = (d: string, rel: string): void => {
      if (out.length >= max) return;
      try {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (out.length >= max) return;
          if (IGNORE.has(e.name)) continue;
          const r = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(join(d, e.name), r);
          else if (matchGlob(pattern, r)) out.push(r);
        }
      } catch {
        /* skip */
      }
    };
    walk(dir, "");
    return { pattern, results: out, count: out.length };
  };
}

// ─── grep ───
export const grepTool: ToolDefinition = {
  name: "grep",
  description: "Search file contents with regex. Returns files + line numbers.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Regex pattern" },
      path: { type: "string" },
      include: { type: "string", description: "Filter e.g. *.ts" },
      maxResults: { type: "number" },
    },
    required: ["query"],
  },
  permissions: { requiresPermission: false },
  timeout: 20_000,
  riskLevel: "safe",
};

export function grepHandler(workspaceDir: string) {
  return async (args: Record<string, unknown>) => {
    const query = args.query as string;
    const rawDir = (args.path as string) || ".";
    const sensitive = isSensitivePath(rawDir);
    if (sensitive) return { error: `Refusing to search sensitive path (${sensitive}): ${rawDir}`, denied: true };
    const dir = safePath(workspaceDir, rawDir);
    if (!dir) return { error: "Path escapes workspace", denied: true };
    const max = (args.maxResults as number) || 50;
    const include = args.include as string | undefined;
    const incRe = include ? new RegExp(include.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$") : null;
    let re: RegExp;
    try {
      re = new RegExp(query);
    } catch {
      return { error: `Invalid regex: ${query}` };
    }
    const results: Array<{ file: string; line: number; match: string }> = [];
    const walk = (d: string): void => {
      if (results.length >= max) return;
      try {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          if (results.length >= max) return;
          if (IGNORE.has(e.name)) continue;
          const full = join(d, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.isFile()) {
            if (incRe && !incRe.test(e.name)) continue;
            // Never slurp private key material into context via broad greps.
            if (isSensitivePath(e.name)) continue;
            try {
              const lines = readFileSync(full, "utf-8").split("\n");
              lines.forEach((l, i) => {
                if (results.length >= max) return;
                if (re.test(l)) {
                  re.lastIndex = 0;
                  results.push({
                    file: full.replace(workspaceDir + "/", ""),
                    line: i + 1,
                    match: l.trim().slice(0, 300),
                  });
                }
              });
            } catch {
              /* binary */
            }
          }
        }
      } catch {
        /* skip */
      }
    };
    walk(dir);
    return { query, results, count: results.length };
  };
}
