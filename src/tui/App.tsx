// ─── TUI coding agent (Ink): chat + input + live tool-calling ───
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin, useStdout } from "ink";
import TextInput from "ink-text-input";
import { SingleAgent, type AgentEvent } from "../agent.js";
import {
  fetchProviderModels,
  findModel,
  isChatModelId,
  listModels,
  testProviderConnection,
} from "../llm/models.js";
import { credentialSummary, removeCredential, resolveCredentials, saveCredential } from "../auth.js";
import { PROVIDER_PRESETS, SUPPORTED_PROVIDERS } from "../settings.js";
import { listProjects, projectIdFor, projectSessions } from "../projects.js";
import { rpmFromSettings } from "../settings.js";
import { readFileSync, existsSync, statSync } from "node:fs";
import { safePath } from "../tools/sandbox.js";
import { summarizeCall, summarizeResult } from "../tools/summary.js";
import { highlight, type HlSeg } from "./highlight.js";
import { createMouseParser, stripMouseSequences } from "./mouse.js";
import { buildPreviewForTool } from "./preview.js";
import { bannerSegs, hasChatItems } from "./banner.js";
import type { PermissionAsker, PermissionRequest, AskerVerdict } from "../utils/permissions.js";
import { listAgents, loadAgent, runSubAgent } from "../subagents.js";
import { listSkills, loadSkill } from "../skills.js";
import { formatTodos, loadTodos } from "../todo.js";
import { createCheckpoint, listCheckpoints, rewindToCheckpoint } from "../checkpoint.js";
import { contextUsage } from "../session/context.js";
import { flog } from "../utils/filelog.js";
import {
  createSession,
  lastSession,
  listSessions,
  loadSession,
  saveSession,
  type Session,
} from "../session/store.js";
import { helpText, matchModelName, parseCommand } from "./commands.js";

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      preview: PreviewRef;
      summary: string;
      detail?: string;
      status: "running" | "ok" | "error";
      /** Output mentah terpotong (untuk pratinjau fullscreen). */
      output?: string;
    }
  | { kind: "info"; tone: "dim" | "yellow" | "red" | "green"; text: string };

/** Referensi minimal untuk membangun pratinjau (tanpa konten besar). */
export interface PreviewRef {
  name: string;
  path?: string;
  command?: string;
  url?: string;
  query?: string;
  pattern?: string;
}

/** Batas simpan output per tool-call (pratinjau). */
export const PREVIEW_STORE_CAP = 20_000;

export function previewRefFor(name: string, args: Record<string, unknown>): PreviewRef {
  const s = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
  return {
    name,
    path: s(args.path),
    command: s(args.command),
    url: s(args.url),
    query: s(args.query),
    pattern: s(args.pattern),
  };
}

function capOutput(output: unknown): string | undefined {
  if (output === undefined) return undefined;
  const s = typeof output === "string" ? output : JSON.stringify(output);
  return s.length > PREVIEW_STORE_CAP ? s.slice(0, PREVIEW_STORE_CAP) + "\n…[dipotong]" : s;
}

export interface TuiOptions {
  initialSession: Session;
  workspaceDir: string;
  maxSteps: number;
  initialPrompt?: string;
}

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// Langkah scroll chat per tekan tombol panah (baris).
const SCROLL_STEP = 3;

function truncate(s: string, n = 400): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// ─── Perkiraan lebar sel terminal (bias ke ATAS agar tak overflow) ───
function cellWidth(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n += 1;
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2300 && cp <= 0x27bf) || // simbol teknis/dingbats: hitung 2 (aman)
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
    ) {
      n += 1;
    }
  }
  return n;
}

function itemText(it: ChatItem): string {
  switch (it.kind) {
    case "user":
      return `❯ ${it.text}`;
    case "assistant":
      return it.text;
    case "tool": {
      const icon = it.status === "running" ? "⏳" : it.status === "ok" ? "✓" : "✗";
      return `${icon} ${it.summary}${it.detail ? ` · ${it.detail}` : ""}`;
    }
    case "info":
      return it.text;
  }
}

/** Chrome box per kind: border(2) + margin bawah(1) untuk boxed, 0 untuk info. */
function boxChrome(it: ChatItem): number {
  return it.kind === "info" ? 0 : 3;
}

/** Perkiraan tinggi item dalam baris terminal (sudah termasuk border + margin). */
export function itemRows(it: ChatItem, cols: number): number {
  const boxed = it.kind !== "info";
  const w = Math.max(20, cols - (boxed ? 6 : 4));
  const lines = itemText(it)
    .split("\n")
    .reduce((n, ln) => n + Math.max(1, Math.ceil(cellWidth(ln) / w)), 0);
  return lines + boxChrome(it);
}

/**
 * Hitung jendela item yang muat di layar.
 * @param heights tinggi tiap item (searah feed, lama → baru)
 * @param avail baris tersedia untuk chat
 * @param scroll baris yang disembunyikan dari bawah (0 = menempel ekor)
 * @returns start/end (end eksklusif) + scroll yang sudah dijepit
 *
 * scroll 0 → ekor selalu terlihat. Menaikkan scroll menggeser jendela ke atas.
 * Item yang hanya muat sebagian TIDAK dirender (mencegah overlap).
 */
export function computeWindow(
  heights: number[],
  avail: number,
  scroll: number,
): { start: number; end: number; scroll: number; total: number } {
  const total = heights.reduce((a, b) => a + b, 0);
  const s = Math.min(Math.max(0, Math.floor(scroll)), Math.max(0, total - avail));
  // Lewati `s` baris dari bawah (item utuh saja). Item yang hanya muat
  // sebagian di bawah ikut dibuang — kalau dirender ia overflow menabrak
  // input box (sumber layar "nabrak").
  let end = heights.length;
  let skipped = 0;
  while (end > 0 && skipped + heights[end - 1] <= s) {
    skipped += heights[end - 1];
    end--;
  }
  if (end > 0 && skipped < s) end--;
  // Ambil mundur maksimal `avail` baris (item utuh saja).
  let start = end;
  let used = 0;
  while (start > 0 && used + heights[start - 1] <= avail) {
    used += heights[start - 1];
    start--;
  }
  return { start, end, scroll: s, total };
}

/**
 * Potong item raksasa (assistant/info): ambil ekornya saja agar muat maxRows.
 * Mencegah satu item mendorong seluruh layar (chat tak pernah kosong).
 * Untuk info: pertahankan HEADER (baris pertama) agar judul tidak hilang.
 */
export function sliceItemTail(it: ChatItem, maxRows: number, cols: number): ChatItem {
  if (it.kind !== "assistant" && it.kind !== "info" && it.kind !== "user") return it;
  const boxed = it.kind !== "info";
  // konten ≤ maxRows - penanda(1) - chrome(box border+margin, 0 utk info)
  const budget = Math.max(1, maxRows - 1 - (boxed ? 3 : 0));
  const w = Math.max(20, cols - (boxed ? 6 : 4));
  const lines = it.text.split("\n");
  if (it.kind === "info") {
    // Untuk info: pertahankan baris pertama (header) + berikutnya sampai budget habis
    let used = 0;
    let to = 0;
    while (to < lines.length) {
      const h = Math.max(1, Math.ceil(cellWidth(lines[to]) / w));
      if (used + h > budget) break;
      used += h;
      to++;
    }
    if (to >= lines.length) return it;
    return { ...it, text: lines.slice(0, to).join("\n") + `\n… (${lines.length - to} baris di bawah disembunyikan)` };
  }
  // assistant/user: ambil ekor
  let used = 0;
  let from = lines.length;
  while (from > 0) {
    const h = Math.max(1, Math.ceil(cellWidth(lines[from - 1]) / w));
    if (used + h > budget) break;
    used += h;
    from--;
  }
  if (from <= 0) return it;
  return { ...it, text: `… (${lines.length - from} baris di atas disembunyikan)\n` + lines.slice(from).join("\n") };
}

/** Tinggi baris teks (untuk panel pratinjau & peta klik). */
function wrapRows(s: string, w: number): number {
  const ww = Math.max(20, w);
  return s.split("\n").reduce((n, ln) => n + Math.max(1, Math.ceil(cellWidth(ln) / ww)), 0);
}

export interface PreviewKey {
  ctrl?: boolean;
  escape?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  return?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
}

export type PreviewKeyAction = "close" | "up" | "down" | "pageup" | "pagedown" | null;

/**
 * Tombol saat preview fullscreen terbuka → aksi. Pure agar bisa di-unit-test.
 * Esc SELALU menutup (tidak ada pengecualian state lain) — regresi bug Esc mati.
 */
export function previewKeyAction(inp: string, key: PreviewKey): PreviewKeyAction {
  if (key.escape) return "close";
  if (key.ctrl && inp === "c") return "close";
  if (key.upArrow) return "up";
  if (key.downArrow) return "down";
  if (key.pageUp) return "pageup";
  if (key.pageDown) return "pagedown";
  return null;
}

/** Tampilkan prompt asli, bukan blob konteks awal.
 *  Bentuk blob: "## USER REQUEST\n<prompt>\n\n## WORKSPACE\n...".
 *  Hanya bagian prompt yang ditampilkan; section berikutnya dipotong. */
export function displayPrompt(content: string): string {
  const lines = content.split("\n");
  const reqIdx = lines.findIndex((l) => l.trim() === "## USER REQUEST");
  const raw = reqIdx >= 0 ? lines.slice(reqIdx + 1) : lines;
  const prompt: string[] = [];
  let started = reqIdx < 0;
  for (const l of raw) {
    if (/^##\s/.test(l)) {
      if (started) break; // section berikutnya (WORKSPACE/FILE TREE/…) bukan prompt
      continue;
    }
    started = true;
    prompt.push(l);
  }
  const t = prompt.join("\n").trim();
  return truncate(t || content);
}

/** Catatan error transien (Ctrl+C/abort) — disembunyikan saat resume, basi. */
const ABORT_RE = /^Tool error dari LLM:/;

function tryParseToolOutput(content: string): unknown {
  const t = content.trim();
  if (!(t.startsWith("{") && t.endsWith("}"))) return content;
  try {
    return JSON.parse(t);
  } catch {
    return content;
  }
}

function toolStatusOf(parsed: unknown): "ok" | "error" {
  if (parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string") {
    return "error";
  }
  return "ok";
}

/**
 * Bangun ulang item chat dari riwayat tersimpan (resume).
 * Baris tool direkonstruksi ringkas (tanpa dump isi) agar tampilan resume
 * sama dengan sesi live: pasangan assistant.tool_calls ↔ pesan tool.
 */
export function rebuildItems(messages: Session["messages"]): ChatItem[] {
  const out: ChatItem[] = [];
  const toolById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) toolById.set(m.tool_call_id, m.content);
  }
  for (const m of messages) {
    if (m.role === "user") {
      if (ABORT_RE.test(m.content.trim())) continue;
      out.push({ kind: "user", text: displayPrompt(m.content) });
    } else if (m.role === "assistant") {
      if (m.content.trim()) out.push({ kind: "assistant", text: m.content });
      for (const tc of m.tool_calls ?? []) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          args = {};
        }
        const raw = toolById.get(tc.id);
        const parsed = raw !== undefined ? tryParseToolOutput(raw) : undefined;
        const status = toolStatusOf(parsed);
        out.push({
          kind: "tool",
          id: tc.id,
          name: tc.function.name,
          preview: previewRefFor(tc.function.name, args),
          summary: summarizeCall(tc.function.name, args),
          detail:
            parsed !== undefined
              ? (summarizeResult(tc.function.name, {
                  status: status === "ok" ? "success" : "error",
                  output: parsed,
                  durationMs: 0,
                }) ?? undefined)
              : undefined,
          status,
          output: parsed !== undefined ? capOutput(parsed) : undefined,
        });
      }
    }
  }
  return out;
}

function makeAgent(
  session: Session,
  maxSteps: number,
  onEvent: (ev: AgentEvent) => void,
  asker: PermissionAsker,
): SingleAgent {
  const creds = resolveCredentials(session.provider);
  return new SingleAgent({
    model: session.model,
    provider: session.provider,
    apiKey: creds.apiKey,
    baseUrl: creds.baseUrl,
    maxTokens: 8_192,
    maxSteps,
    // Izin terminal/file ditanya inline (asker) + disimpan per session.
    autoApprove: false,
    approvals: session.approvals,
    askPermission: asker,
    rpm: rpmFromSettings(),
    onEvent,
  });
}

export function App({ initialSession, workspaceDir, maxSteps, initialPrompt }: TuiOptions): React.JSX.Element {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { stdout } = useStdout();

  // Ukuran terminal aktual (fullscreen) + ikuti resize.
  const [size, setSize] = useState(() => ({
    columns: stdout?.columns || 80,
    rows: stdout?.rows || 24,
  }));
  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize({ columns: stdout.columns || 80, rows: stdout.rows || 24 });
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  const [session, setSession] = useState<Session>(initialSession);
  const [items, setItems] = useState<ChatItem[]>(() =>
    initialSession.messages.length > 0
      ? [
          {
            kind: "info" as const,
            tone: "dim" as const,
            text: `Melanjutkan session ${initialSession.id.slice(0, 8)} (${initialSession.messages.length} pesan).`,
          },
          ...rebuildItems(initialSession.messages),
        ]
      : [],
  );
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [stream, setStream] = useState("");
  const [cutoff, setCutoff] = useState(0);
  const [scrollOffset, setScrollOffset] = useState(0);
  const [spin, setSpin] = useState(0);

  const sessionRef = useRef(session);
  const itemsRef = useRef(items);
  const streamRef = useRef("");
  const runningRef = useRef(false);
  const agentRef = useRef<SingleAgent | null>(null);
  // Daftar model live terakhir (untuk pilih via /models <nomor>).
  const modelPickRef = useRef<{ provider: string; models: string[] } | null>(null);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  const push = useCallback((item: ChatItem) => {
    setItems((prev) => [...prev, item]);
  }, []);

  const flushStream = useCallback(() => {
    const t = streamRef.current;
    streamRef.current = "";
    setStream("");
    if (t.trim()) push({ kind: "assistant", text: t });
  }, [push]);

  const persist = useCallback((s: Session) => {
    sessionRef.current = s;
    setSession(s);
    saveSession(s);
  }, []);

  // ── Izin terminal/file inline: [y] sekali / [a] semua serupa / [n] tolak ──
  const [approval, setApproval] = useState<{ label: string; scope: string } | null>(null);

  // ── Dropdown SelectList untuk model/provider ──
  const [dropdown, setDropdown] = useState<{
    type: "models" | "providers";
    options: string[];
    selected: number;
    onSelect: (value: string) => void;
  } | null>(null);

  const openModelDropdown = useCallback((options: string[], onSelect: (value: string) => void) => {
    setDropdown({ type: "models", options, selected: 0, onSelect });
  }, []);

  const openProviderDropdown = useCallback((options: string[], onSelect: (value: string) => void) => {
    setDropdown({ type: "providers", options, selected: 0, onSelect });
  }, []);

  const closeDropdown = useCallback(() => {
    setDropdown(null);
  }, []);
  const approvalResolve = useRef<((v: AskerVerdict) => void) | null>(null);
  const approvalActive = useRef(false);

  const asker = useCallback((_req: PermissionRequest): Promise<AskerVerdict> => {
    return new Promise((resolve) => {
      approvalResolve.current = resolve;
      approvalActive.current = true;
      const label = _req.command
        ? `$ ${_req.command.replace(/\s+/g, " ").trim().slice(0, 100)}`
        : summarizeCall(_req.tool, _req.args);
      setApproval({ label, scope: _req.base ? `semua "${_req.base}"` : "semua yang serupa" });
    });
  }, []);

  const answerApproval = useCallback((v: AskerVerdict) => {
    const r = approvalResolve.current;
    approvalResolve.current = null;
    approvalActive.current = false;
    setApproval(null);
    // Engine menyimpan "all"/"deny" sendiri; sinkron ke session terjadi
    // saat turn selesai (runTurn) agar tidak menyimpan state basi.
    if (r) r(v);
  }, []);

/** State pratinjau fullscreen: judul + baris token + teks polos per baris. */
interface PreviewState {
  title: string;
  segs: HlSeg[][];
  plain: string[];
}

  // ── Pratinjau fullscreen baris tool (klik → buka, Esc → tutup) ──
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [previewScroll, setPreviewScroll] = useState(0);
  const rowMapRef = useRef<Array<{ y0: number; y1: number; id: string }>>([]);
  const lastMouseAt = useRef(0);
  const openPreviewRef = useRef<(id: string) => void>(() => {});
  const clickRef = useRef<{ rowMap: Array<{ y0: number; y1: number; id: string }>; previewOpen: boolean }>({
    rowMap: [],
    previewOpen: false,
  });

  const closePreview = useCallback(() => {
    setPreview(null);
    setPreviewScroll(0);
  }, []);

  const openPreviewById = useCallback(
    (id: string) => {
      const it = itemsRef.current.find((m) => m.kind === "tool" && m.id === id);
      if (!it || it.kind !== "tool") return;
      const pv = buildPreviewForTool(it, workspaceDir);
      const segs = highlight(pv.body, pv.lang);
      setPreview({
        title: pv.title,
        segs,
        plain: segs.map((ln) => ln.map((s) => s.text).join("")),
      });
      setPreviewScroll(0);
      setDropdown(null);
    },
    [workspaceDir],
  );

  // ── Event dari agent → update TUI ──
  const handleEvent = useCallback(
    (ev: AgentEvent) => {
      switch (ev.type) {
        case "text":
          streamRef.current += ev.delta;
          setStream(streamRef.current);
          break;
        case "text_end":
        case "step":
          flushStream();
          break;
        case "tool_start":
          flushStream();
          push({
            kind: "tool",
            id: ev.call.id,
            name: ev.call.name,
            preview: previewRefFor(ev.call.name, ev.call.args),
            summary: summarizeCall(ev.call.name, ev.call.args),
            status: "running",
          });
          break;
        case "tool_end":
          flushStream();
          setItems((prev) =>
            prev.map((it) =>
              it.kind === "tool" && it.id === ev.call.id
                ? {
                    ...it,
                    status: ev.status === "success" ? "ok" : "error",
                    detail: ev.summary,
                    output: capOutput(ev.output),
                  }
                : it,
            ),
          );
          break;
        case "warn":
          flushStream();
          push({ kind: "info", tone: "yellow", text: ev.message });
          break;
        case "error":
          flushStream();
          push({ kind: "info", tone: "red", text: ev.message });
          break;
        case "trimmed":
          push({ kind: "info", tone: "yellow", text: `Konteks dipangkas (${ev.count} pesan) agar muat di window model.` });
          break;
        case "compacted":
          push({ kind: "info", tone: "green", text: `Konteks dipadatkan otomatis (${ev.dropped} pesan → ringkasan). Lanjut…` });
          break;
        case "done":
          flushStream();
          break;
      }
    },
    [flushStream, push],
  );

  if (!agentRef.current) {
    agentRef.current = makeAgent(sessionRef.current, maxSteps, handleEvent, asker);
  }

  const runTurn = useCallback(
    async (prompt: string) => {
      if (runningRef.current) {
        push({ kind: "info", tone: "yellow", text: "Tunggu turn selesai (Ctrl+C untuk batalkan)." });
        return;
      }
      runningRef.current = true;
      setRunning(true);
      push({ kind: "user", text: prompt });
      try {
        const sess = sessionRef.current;
        const { messages, result } = await agentRef.current!.chatTurn(prompt, workspaceDir, sess.messages);
        flushStream();
        persist({ ...sess, messages, filesModified: result.filesModified, approvals: agentRef.current!.getApprovals() });
        if (!result.success) {
          push({
            kind: "info",
            tone: "red",
            text: result.finalText || "Turn selesai tanpa hasil — cek error di atas.",
          });
        }
      } catch (e) {
        flushStream();
        push({ kind: "info", tone: "red", text: `Gagal: ${(e as Error).message}` });
      } finally {
        runningRef.current = false;
        setRunning(false);
      }
    },
    [flushStream, persist, push, workspaceDir],
  );

  // ── Slash commands ──
  const execCommand = useCallback(
    async (name: string, args: string[]) => {
      const sess = sessionRef.current;
      const agent = agentRef.current!;

      /** Ganti model session aktif (dipakai /models). */
      const doSelectModel = (id: string) => {
        const known = findModel(id, sess.provider);
        const creds = resolveCredentials(sess.provider);
        agent.setModelProvider(id, sess.provider, creds.apiKey, creds.baseUrl);
        persist({ ...sess, model: id });
        push({
          kind: "info",
          tone: "green",
          text: known
            ? `Model → ${id} (window ${known.contextWindow.toLocaleString()} token)`
            : `Model → ${id} (tidak di katalog, pakai window default provider)`,
        });
      };

      /** Pindah provider (dipakai /providers use). */
      const doSwitchProvider = async (p: string): Promise<boolean> => {
        if (!SUPPORTED_PROVIDERS.includes(p)) {
          push({ kind: "info", tone: "red", text: `Provider tak dikenal: ${p}` });
          return false;
        }
        const creds = resolveCredentials(p);
        if (!creds.apiKey && p !== "ollama" && p !== "mock") {
          push({ kind: "info", tone: "red", text: `Provider ${p} butuh API key — /login ${p} <key> atau sabana-code auth login ${p}. Dibatalkan.` });
          return false;
        }
        agent.setModelProvider(sess.model, p, creds.apiKey, creds.baseUrl);
        modelPickRef.current = null; // daftar /models lama tak berlaku lagi
        persist({ ...sess, provider: p });
        push({ kind: "info", tone: "green", text: `Provider → ${p}. Menguji koneksi…` });
        const test = await testProviderConnection(p);
        push({ kind: "info", tone: test.ok ? "green" : "red", text: test.detail });
        return test.ok;
      };

      /** Simpan kredensial (dipakai /login dan /providers login). */
      const doLogin = (p: string, key: string, base: string): boolean => {
        if (!p || !key || !SUPPORTED_PROVIDERS.includes(p) || p === "mock") {
          push({ kind: "info", tone: "red", text: "Pakai: /login <provider> <api-key> [base-url]" });
          return false;
        }
        saveCredential(p, key, base || "");
        push({ kind: "info", tone: "green", text: `Kredensial ${p} tersimpan global. Kini bisa jalan dari direktori mana pun.` });
        return true;
      };

      switch (name) {
        case "help": {
          push({ kind: "info", tone: "dim", text: helpText() });
          break;
        }
        case "new": {
          persist(createSession(sess.model, sess.provider, workspaceDir));
          agentRef.current = makeAgent(sessionRef.current, maxSteps, handleEvent, asker);
          setCutoff(itemsRef.current.length + 1);
          setScrollOffset(0);
          push({ kind: "info", tone: "green", text: `Session baru: ${sessionRef.current.id.slice(0, 8)}` });
          break;
        }
        case "sessions": {
          const list = listSessions();
          if (list.length === 0) push({ kind: "info", tone: "dim", text: "Belum ada session tersimpan." });
          else
            push({
              kind: "info",
              tone: "dim",
              text: ["Session tersimpan:", ...list.slice(0, 15).map((s, i) => `  ${i + 1}. ${s.id.slice(0, 8)}  ${s.title}  [${s.model}/${s.provider}]  ${s.turns} turns`)].join("\n"),
            });
          break;
        }
        case "projects": {
          const mine = projectIdFor(workspaceDir);
          const list = listProjects();
          if (list.length === 0) push({ kind: "info", tone: "dim", text: "Belum ada project terdaftar." });
          else
            push({
              kind: "info",
              tone: "dim",
              text: [
                "Project (riwayat per folder):",
                ...list.slice(0, 15).map((p) => `  ${p.id === mine ? "●" : "○"} ${p.name}  ${p.sessions} session  ${p.path}`),
              ].join("\n"),
            });
          const mineInfo = list.find((p) => p.id === mine);
          if (mineInfo && mineInfo.sessions > 0) {
            const ss = projectSessions(mine)
              .map((s) => `  - ${s.id.slice(0, 8)}  ${s.title}`)
              .join("\n");
            if (ss) push({ kind: "info", tone: "dim", text: `Session di project ini:\n${ss}\nLanjutkan: /resume <id>` });
          }
          break;
        }
        case "agents": {
          const list = listAgents();
          if (list.length === 0)
            push({ kind: "info", tone: "dim", text: "Belum ada profil di ~/sabana-code/agents/. Buat <nama>.md dengan frontmatter name/description." });
          else
            push({
              kind: "info",
              tone: "dim",
              text: ["Sub-agent kustom:", ...list.map((a) => `  ${a.name} — ${a.description}${a.model ? ` (model: ${a.model})` : ""}`), "Pakai: /agent <nama> <tugas>"].join("\n"),
            });
          break;
        }
        case "agent": {
          const [aname, ...rest] = args;
          const profile = aname ? loadAgent(aname) : null;
          if (!profile) {
            push({ kind: "info", tone: "red", text: aname ? `Sub-agent '${aname}' tidak ada. /agents untuk daftar.` : "Pakai: /agent <nama> <tugas>" });
            break;
          }
          const task = rest.join(" ").trim();
          if (!task) {
            push({ kind: "info", tone: "red", text: `Pakai: /agent ${profile.name} <tugas>` });
            break;
          }
          if (runningRef.current) {
            push({ kind: "info", tone: "yellow", text: "Tunggu turn selesai dulu." });
            break;
          }
          runningRef.current = true;
          setRunning(true);
          push({ kind: "info", tone: "dim", text: `→ mendelegasikan ke ${profile.name}: ${truncate(task, 140)}` });
          try {
            const sess = sessionRef.current;
            const creds = resolveCredentials(sess.provider);
            const sub = await runSubAgent(profile, task, workspaceDir, {
              provider: sess.provider,
              apiKey: creds.apiKey,
              baseUrl: creds.baseUrl,
              model: sess.model,
              maxTokens: 8_192,
              maxSteps: Math.min(20, maxSteps),
              approvals: sess.approvals,
              askPermission: asker,
            });
            push({ kind: "assistant", text: sub.text.trim() || "(sub-agent tanpa jawaban teks)" });
            // Gabungkan izin baru dari sub-agent ke session + engine utama.
            agentRef.current?.mergeApprovals(sub.approvals);
            persist({
              ...sess,
              messages: [
                ...sess.messages,
                { role: "user" as const, content: `[sub-agent ${profile.name}] ${task}` },
                { role: "assistant" as const, content: sub.text },
              ],
              filesModified: [...new Set([...sess.filesModified, ...sub.files])],
              approvals: agentRef.current?.getApprovals() ?? sess.approvals,
            });
            if (!sub.success) push({ kind: "info", tone: "yellow", text: "Sub-agent selesai tanpa hasil penuh." });
          } catch (e) {
            push({ kind: "info", tone: "red", text: `Sub-agent gagal: ${(e as Error).message}` });
          } finally {
            runningRef.current = false;
            setRunning(false);
          }
          break;
        }
        case "resume": {
          if (!args[0]) {
            const last = lastSession();
            if (!last) {
              push({ kind: "info", tone: "red", text: "Belum ada session. Pakai /resume <id>." });
              break;
            }
            args = [last.id];
          }
          let target = loadSession(args[0]);
          if (!target) {
            const idx = parseInt(args[0], 10);
            const list = listSessions();
            if (!isNaN(idx) && idx >= 1 && idx <= list.length) target = loadSession(list[idx - 1].id);
          }
          if (!target) {
            push({ kind: "info", tone: "red", text: `Session '${args[0]}' tidak ditemukan.` });
            break;
          }
          persist(target);
          agentRef.current = makeAgent(target, maxSteps, handleEvent, asker);
          setCutoff(itemsRef.current.length + 1);
          setScrollOffset(0);
          push({ kind: "info", tone: "green", text: `Melanjutkan session ${target.id.slice(0, 8)} (${target.messages.length} pesan).` });
          for (const it of rebuildItems(target.messages)) push(it);
          break;
        }
        case "providers": {
          const sub = (args[0] || "list").toLowerCase();
          // Buka dropdown jika tidak ada subcommand atau subcommand "select"
          if (sub === "list" || sub === "select" || sub === "") {
            const providers = SUPPORTED_PROVIDERS.filter((p) => p !== "mock");
            openProviderDropdown(providers, async (pick) => {
              await doSwitchProvider(pick);
            });
            break;
          }
          if (sub === "use" && args[1]) {
            await doSwitchProvider(args[1].toLowerCase());
            break;
          }
          if (sub === "login" && args[1] && args[2]) {
            doLogin(args[1].toLowerCase(), args[2], args[3] || "");
            break;
          }
          push({ kind: "info", tone: "red", text: "Pakai: /providers [list]  •  /providers use <nama>  •  /providers login <nama> <key> [base-url]" });
          break;
        }
        case "models": {
          const arg = (args[0] || "").trim();
          const pending = modelPickRef.current?.provider === sess.provider ? modelPickRef.current : null;
          // Pilih via nomor dari daftar terakhir.
          if (/^\d+$/.test(arg) && pending) {
            const idx = parseInt(arg, 10) - 1;
            const pick = pending.models[idx];
            if (!pick) {
              push({ kind: "info", tone: "red", text: `Nomor di luar daftar (1–${pending.models.length}).` });
              break;
            }
            modelPickRef.current = null;
            doSelectModel(pick);
            break;
          }
          // Input manual: cocok persis ke daftar terakhir atau katalog (tanpa fetch).
          if (arg && !/^\d+$/.test(arg)) {
            const exact = matchModelName(arg, pending?.models ?? [], listModels(sess.provider).map((m) => m.id));
            if (exact) {
              modelPickRef.current = null;
              doSelectModel(exact);
              break;
            }
          }
          const filter = /^\d+$/.test(arg) ? "" : arg.toLowerCase();
          push({ kind: "info", tone: "dim", text: `Mengambil daftar model ${sess.provider}…` });
          const live = await fetchProviderModels(sess.provider);
          if (!live.ok) {
            const known = listModels(sess.provider);
            push({
              kind: "info",
              tone: "yellow",
              text: [`Live gagal (${live.error}). Katalog bawaan:`, ...known.map((m) => `  ${m.id} — ${m.description}`), "Pilih: /models <nomor|nama persis>"].join("\n"),
            });
            break;
          }
          let models = live.models.filter(isChatModelId);
          if (filter) models = models.filter((m) => m.toLowerCase().includes(filter));
          if (models.length === 0) {
            push({ kind: "info", tone: "red", text: "Tidak ada model cocok. Coba filter lain atau ketik nama persis: /models <nama>." });
            break;
          }
          const CAP = 40;
          const shown = models.slice(0, CAP);
          modelPickRef.current = { provider: sess.provider, models: shown };
          // Buka dropdown jika tidak ada argumen atau user minta pilih
          if (!arg) {
            openModelDropdown(shown, (pick) => {
              doSelectModel(pick);
            });
            break;
          }
          push({
            kind: "info",
            tone: "dim",
            text: [
              `Model ${sess.provider} (${live.source === "live" ? "live" : "katalog"}${models.length > CAP ? `, tampil ${CAP}/${models.length}` : `, ${models.length}`}) — aktif: ${sess.model}`,
              ...shown.map((m, i) => `  ${i + 1}. ${m}${m === sess.model ? "  ← aktif" : ""}`),
              "Pilih: /models <nomor|nama persis>  atau ketik /models saja untuk dropdown",
            ].join("\n"),
          });
          break;
        }
        case "skills": {
          const list = listSkills(workspaceDir);
          if (list.length === 0)
            push({ kind: "info", tone: "dim", text: "Belum ada skill. Buat *.md di ~/sabana-code/skills/ atau <project>/.sabana/skills/ (frontmatter name/description)." });
          else
            push({
              kind: "info",
              tone: "dim",
              text: ["Skills:", ...list.map((s) => `  ${s.name} — ${s.description} [${s.scope}]`), "Lihat isi: /skill <nama>"].join("\n"),
            });
          break;
        }
        case "skill": {
          const sname = (args[0] || "").toLowerCase();
          if (!sname) {
            push({ kind: "info", tone: "red", text: "Pakai: /skill <nama>" });
            break;
          }
          const s = loadSkill(sname, workspaceDir);
          if (!s) {
            push({ kind: "info", tone: "red", text: `Skill '${sname}' tidak ada. /skills untuk daftar.` });
            break;
          }
          const body = s.instructions.length > 3000 ? s.instructions.slice(0, 3000) + "\n…(dipotong)" : s.instructions;
          push({ kind: "info", tone: "dim", text: `Skill ${s.name} [${s.scope}] — ${s.description}\n\n${body}` });
          break;
        }
        case "todo": {
          const list = loadTodos(workspaceDir);
          const done = list.items.filter((t) => t.status === "completed").length;
          push({
            kind: "info",
            tone: "dim",
            text: `Todo (${done}/${list.items.length} selesai):\n${formatTodos(list.items)}`,
          });
          break;
        }
        case "mcp": {
          if ((args[0] || "").toLowerCase() === "reload") {
            push({ kind: "info", tone: "dim", text: "Memuat ulang MCP…" });
            try {
              const r = await agent.reloadMcp();
              push({
                kind: "info",
                tone: r.errors.length > 0 ? "yellow" : "green",
                text: `MCP reload: +${r.added} tools${r.errors.length > 0 ? `\nGagal: ${r.errors.join("; ")}` : ""}`,
              });
            } catch (e) {
              push({ kind: "info", tone: "red", text: `MCP reload gagal: ${(e as Error).message}` });
            }
          }
          const st = agent.mcpStatus();
          if (st.length === 0)
            push({ kind: "info", tone: "dim", text: "Belum ada server MCP. Tambahkan di ~/sabana-code/mcp.json lalu /mcp reload." });
          else
            push({
              kind: "info",
              tone: "dim",
              text: [
                "MCP:",
                ...st.map((s) =>
                  s.state === "up"
                    ? `  ● ${s.name} — ${s.tools.length} tools`
                    : `  ○ ${s.name} — down${s.error ? `: ${s.error.slice(0, 120)}` : ""}`,
                ),
              ].join("\n"),
            });
          break;
        }
        case "checkpoint": {
          const label = args.join(" ").trim();
          const cp = createCheckpoint(sess, workspaceDir, label || undefined);
          push({ kind: "info", tone: "green", text: `Checkpoint tersimpan: ${cp.id.slice(0, 8)} "${cp.label}" (${cp.files.length} file, ${cp.messages.length} pesan). Mundur: /rewind ${cp.id.slice(0, 8)}` });
          break;
        }
        case "checkpoints": {
          const list = listCheckpoints(sess.id);
          if (list.length === 0) push({ kind: "info", tone: "dim", text: "Belum ada checkpoint di session ini. Buat: /checkpoint [label]" });
          else
            push({
              kind: "info",
              tone: "dim",
              text: ["Checkpoints:", ...list.map((c) => `  ${c.id.slice(0, 8)}  "${c.label}"  ${c.files} file  ${c.messages} pesan`), "Mundur: /rewind <id>"].join("\n"),
            });
          break;
        }
        case "rewind": {
          const id = args[0];
          if (!id) {
            push({ kind: "info", tone: "red", text: "Pakai: /rewind <id> (lihat /checkpoints)" });
            break;
          }
          if (runningRef.current) {
            push({ kind: "info", tone: "yellow", text: "Tunggu turn selesai dulu." });
            break;
          }
          const { session: next, result } = rewindToCheckpoint(sess, workspaceDir, id);
          if (!result.ok) {
            push({ kind: "info", tone: "red", text: result.error || "Rewind gagal." });
            break;
          }
          persist(next);
          setCutoff(itemsRef.current.length + 1);
          setScrollOffset(0);
          for (const it of rebuildItems(next.messages)) push(it);
          const bits = [
            `${result.restored.length} file dikembalikan`,
            ...(result.deleted.length > 0 ? [`${result.deleted.length} file dihapus`] : []),
            ...(result.skipped.length > 0 ? [`${result.skipped.length} dilewati`] : []),
          ];
          push({ kind: "info", tone: "green", text: `Mundur ke checkpoint ${id}: ${bits.join(", ")}. Riwayat: ${next.messages.length} pesan.` });
          break;
        }
        case "compact": {
          if (runningRef.current) {
            push({ kind: "info", tone: "yellow", text: "Tunggu turn selesai dulu (Ctrl+C untuk batalkan)." });
            break;
          }
          if (sess.messages.length <= 4) {
            push({ kind: "info", tone: "dim", text: "Riwayat masih pendek — belum perlu dipadatkan." });
            break;
          }
          runningRef.current = true;
          setRunning(true);
          push({ kind: "info", tone: "dim", text: "Meringkas konteks…" });
          try {
            const r = await agent.compactHistory(sess.messages);
            if (!r.ok) {
              push({ kind: "info", tone: "red", text: `Compact gagal: ${r.error}` });
            } else {
              persist({ ...sess, messages: r.messages });
              push({ kind: "info", tone: "green", text: `Konteks dipadatkan (${r.dropped} pesan → ringkasan):\n${r.summary.slice(0, 800)}` });
            }
          } catch (e) {
            push({ kind: "info", tone: "red", text: `Compact gagal: ${(e as Error).message}` });
          } finally {
            runningRef.current = false;
            setRunning(false);
          }
          break;
        }
        case "context": {
          const u = contextUsage(sess.messages, sess.model, sess.provider);
          push({
            kind: "info",
            tone: u.pct > 85 ? "red" : u.pct > 60 ? "yellow" : "dim",
            text: `Konteks: ~${u.tokens.toLocaleString()} / ${u.window.toLocaleString()} token (${u.pct.toFixed(1)}%) • ${sess.messages.length} pesan • model ${sess.model}`,
          });
          break;
        }
        case "tools": {
          push({
            kind: "info",
            tone: "dim",
            text: ["Tools:", ...agent.listTools().map((t) => `  ${t.name} — ${t.description}`)].join("\n"),
          });
          break;
        }
        case "login": {
          // /login <provider> <key> [baseUrl] — simpan ke ~/sabana-code/settings.json
          const [p, key, base] = args;
          doLogin((p || "").toLowerCase(), key || "", base || "");
          break;
        }
        case "logout": {
          const p = args[0];
          if (!p) {
            const rows = credentialSummary().map((c) => `  ${c.provider.padEnd(10)} ${c.source}`).join("\n");
            push({ kind: "info", tone: "dim", text: `Kredensial:\n${rows}\nHapus: /logout <provider>` });
            break;
          }
          const removed = removeCredential(p);
          push({
            kind: "info",
            tone: removed ? "green" : "red",
            text: removed ? `Kredensial ${p} dihapus.` : `Tidak ada kredensial ${p} yang tersimpan.`,
          });
          break;
        }
        case "clear":
          setCutoff(itemsRef.current.length);
          setScrollOffset(0);
          break;
        case "quit":
        case "exit":
          saveSession(sessionRef.current);
          exit();
          break;
        default:
          push({ kind: "info", tone: "red", text: `Perintah tak dikenal: /${name}. Ketik /help.` });
          break;
      }
    },
    [exit, handleEvent, maxSteps, persist, push, workspaceDir, asker],
  );

  const submit = useCallback(
    (value: string) => {
      const text = value.trim();
      if (!text) return;
      setInput("");
      setScrollOffset(0); // output baru → kembali menempel ekor
      const cmd = parseCommand(text);
      if (cmd) void execCommand(cmd.name, cmd.args);
      else void runTurn(text);
    },
    [execCommand, runTurn],
  );

  // Saring sisa sequence mouse dari ketikan (Ink ikut menerima bytes-nya).
  // Lengkap selalu dibuang; serpihan CSI + sisa trailer dibuang hanya
  // sesaat setelah aktivitas mouse (agar tak menelan ketikan normal).
  const onInputChange = useCallback((v: string) => {
    let c = stripMouseSequences(v);
    if (Date.now() - lastMouseAt.current < 300) {
      c = c.replace(/\x1b\[<?[\d;]*/g, "");
      c = c.replace(/^(?:\d+;){1,2}\d*[mM]/, "");
    }
    setInput(c);
  }, []);

  // Auto-submit prompt awal (mis. untuk demo / smoke test)
  const bootRef = useRef(false);
  useEffect(() => {
    if (!bootRef.current && initialPrompt) {
      bootRef.current = true;
      const t = setTimeout(() => submit(initialPrompt), 100);
      return () => clearTimeout(t);
    }
    bootRef.current = true;
  }, [initialPrompt, submit]);

  // Spinner saat agent bekerja
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setSpin((s) => (s + 1) % SPIN.length), 120);
    return () => clearInterval(t);
  }, [running]);

  // Klik mouse pada baris tool → pratinjau fullscreen.
  // Listener sendiri di stdin mentah; Ink tetap menerima bytes-nya sehingga
  // filter di onChange + jendela escape di KeyHandler menangkal sampah ketik.
  useEffect(() => {
    const parser = createMouseParser((c) => {
      const st = clickRef.current;
      if (!st || st.previewOpen) return;
      const hit = st.rowMap.find((r) => c.y >= r.y0 && c.y < r.y1);
      if (hit) openPreviewRef.current(hit.id);
    });
    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf-8");
      // Selalu teruskan ke parser (sequence bisa terpotong antar chunk);
      // cap waktu hanya untuk sequence mouse agar Esc asli tak ikut ditekan.
      if (s.includes("\x1b[<")) lastMouseAt.current = Date.now();
      parser(s);
    };
    process.stdin.on("data", onData);
    return () => {
      process.stdin.off("data", onData);
    };
  }, []);

  const usage = contextUsage(session.messages, session.model, session.provider);
  const visible = items.slice(cutoff).slice(-300);
  // Brand besar tengah saat belum ada percakapan; header kecil biasa setelah ada chat.
  const showBanner = !preview && !hasChatItems(visible);
  const projectName = workspaceDir.split("/").filter(Boolean).pop() || workspaceDir;
  const cols = Math.max(40, size.columns);
  const rows = Math.max(12, size.rows);

  // Dropdown: tampilkan maksimal 8 opsi di sekitar pilihan (agar muat layar).
  const DD_MAX = 8;
  let ddVisible: string[] = [];
  let ddOffset = 0;
  if (dropdown) {
    const n = dropdown.options.length;
    ddOffset = n <= DD_MAX ? 0 : Math.min(Math.max(0, dropdown.selected - Math.floor(DD_MAX / 2)), n - DD_MAX);
    ddVisible = dropdown.options.slice(ddOffset, ddOffset + DD_MAX);
  }

  // Viewport manual arah normal: scrollOffset 0 = ekor (terbaru) menempel bawah.
  // Naikkan scrollOffset untuk melihat riwayat lama; dijepit agar tak kosong.
  const CHROME_ROWS = 4 + 1 + 3 + 1; // header + margin + input + status
  const approvalRows = approval ? 5 : 0;
  const dropdownRows = dropdown ? 8 + ddVisible.length : 0;
  const avail = Math.max(5, rows - CHROME_ROWS - approvalRows - dropdownRows - 2);
  const feed: ChatItem[] = stream ? [...visible, { kind: "assistant", text: `${stream}▍` }] : visible;
  const heights = feed.map((it) => itemRows(it, cols));
  const { start, end, scroll } = computeWindow(heights, avail, scrollOffset);
  let windowed = feed.slice(start, end);
  // Satu item raksasa melebihi layar: tampilkan ekornya, jangan kosongkan chat.
  if (windowed.length === 1 && itemRows(windowed[0], cols) > avail) {
    windowed = [sliceItemTail(windowed[0], avail, cols)];
  }
  // Pengaman lapis kedua: feed tak kosong → jangan pernah tampil kosong.
  if (windowed.length === 0 && feed.length > 0) {
    const anchor = feed[Math.min(Math.max(end - 1, 0), feed.length - 1)];
    windowed = [sliceItemTail(anchor, avail, cols)];
  }

  // ── Peta baris terminal → id tool untuk klik mouse (koordinat 1-based).
  // Header = border(2) + judul + workspace; lalu margin chat.
  const headerTitle = `sabana-code  ${projectName}  ${session.id.slice(0, 8)} • ${session.model}/${session.provider}`;
  const headerRows = 2 + wrapRows(headerTitle, cols - 6) + wrapRows(workspaceDir, cols - 6);
  const chatStartRow = headerRows + 1 + 1;
  {
    let _y = chatStartRow;
    const rowMap: Array<{ y0: number; y1: number; id: string }> = [];
    for (const it of windowed) {
      const h = itemRows(it, cols);
      if (it.kind === "tool") rowMap.push({ y0: _y, y1: _y + h, id: it.id });
      _y += h;
    }
    rowMapRef.current = rowMap;
  }
  clickRef.current = { rowMap: rowMapRef.current, previewOpen: preview !== null };
  openPreviewRef.current = openPreviewById;

  // ── Panel pratinjau fullscreen: border(2) + judul(1) + footer(1).
  const previewAvail = preview ? Math.max(5, rows - 4 - 1 - 4 - 1 - (approval ? 5 : 0)) : 0;
  let pvShown: HlSeg[][] = [];
  let pvStart = 0;
  let pvTotalRows = 0;
  let pvScrollClamped = 0;
  if (preview) {
    const w = Math.max(20, cols - 6);
    const hs = preview.plain.map((l) => Math.max(1, Math.ceil(cellWidth(l) / w)));
    pvTotalRows = hs.reduce((a, b) => a + b, 0);
    const maxP = Math.max(0, pvTotalRows - previewAvail);
    pvScrollClamped = Math.min(previewScroll, maxP);
    let skipped = 0;
    let li = 0;
    while (li < hs.length && skipped + hs[li] <= pvScrollClamped) {
      skipped += hs[li];
      li++;
    }
    if (li < hs.length && skipped < pvScrollClamped) li++; // lewati baris parsial atas
    let used = 0;
    const out: HlSeg[][] = [];
    let idx = li;
    while (idx < preview.segs.length && used < previewAvail) {
      const h = hs[idx] ?? 1;
      if (used + h > previewAvail) break;
      out.push(preview.segs[idx]);
      used += h;
      idx++;
    }
    pvShown = out;
    pvStart = li;
  }

  return (
    <Box flexDirection="column" width={cols} height={rows} paddingX={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Box>
          <Text>
            <Text bold color="cyan">sabana-code</Text>
            <Text bold>  {projectName}</Text>
            <Text dimColor>  {session.id.slice(0, 8)} • {session.model}/{session.provider}</Text>
          </Text>
        </Box>
        <Box><Text dimColor>{workspaceDir}</Text></Box>
      </Box>

      <Box flexDirection="column" flexGrow={1} marginTop={1}>
        {preview ? (
          <Box key="__preview" borderStyle="round" borderColor="magenta" paddingX={1} flexDirection="column" flexGrow={1}>
            <Box marginBottom={1}>
              <Text bold>{truncate(preview.title, cols)}</Text>
            </Box>
            {pvShown.map((ln, i) => (
              <Text key={pvStart + i}>
                {ln.every((s) => s.text === "") ? (
                  " "
                ) : (
                  ln.map((s, j) => (
                    <Text key={j} color={s.dim ? undefined : s.color} dimColor={s.dim ? true : undefined} bold={s.bold}>
                      {s.text}
                    </Text>
                  ))
                )}
              </Text>
            ))}
            <Box marginTop={1}>
              <Text dimColor>
                Esc tutup · ↑↓/PgUp/PgDn scroll{pvTotalRows > previewAvail ? ` · ↑${pvScrollClamped}/${pvTotalRows}` : ""}
              </Text>
            </Box>
          </Box>
        ) : showBanner ? (
          <Box key="__banner" flexDirection="column" flexGrow={1} justifyContent="center" alignItems="center">
            {bannerSegs().map((ln, i) => (
              <Text key={i}>
                {ln.every((s) => s.text === "") ? (
                  " "
                ) : (
                  ln.map((s, j) => (
                    <Text key={j} color={s.dim ? undefined : s.color} dimColor={s.dim ? true : undefined} bold={s.bold}>
                      {s.text}
                    </Text>
                  ))
                )}
              </Text>
            ))}
            {stream ? (
              <Box marginTop={1} alignSelf="flex-start">
                <Text>{stream}▍</Text>
              </Box>
            ) : null}
          </Box>
        ) : (
          windowed.map((it, ri) => {
            const isStream = stream !== "" && start + ri === feed.length - 1;
            const key = isStream ? "__stream" : `${cutoff}-${start + ri}`;
          // Info polos; user/assistant/tool masing-masing punya box + warna sendiri.
          if (it.kind === "info") {
            return (
              <Box key={key}>
                <Text color={it.tone === "dim" ? undefined : it.tone} dimColor={it.tone === "dim"}>{it.text}</Text>
              </Box>
            );
          }
          const borderColor =
            it.kind === "user"
              ? "green"
              : it.kind === "assistant"
                ? "blue"
                : it.status === "running"
                  ? "yellow"
                  : it.status === "error"
                    ? "red"
                    : "gray";
          return (
            <Box key={key} borderStyle="round" borderColor={borderColor} paddingX={1} marginBottom={1}>
              {it.kind === "user" && (
                <Text><Text bold color="green">❯ </Text><Text>{it.text}</Text></Text>
              )}
              {it.kind === "assistant" && <Text>{it.text}</Text>}
              {it.kind === "tool" && (
                <Text dimColor>
                  {it.status === "running" ? "⏳" : it.status === "ok" ? "✓" : "✗"} {it.summary}
                  {it.detail ? ` · ${it.detail}` : ""}
                </Text>
              )}
            </Box>
          );
          }))}
      </Box>

      {dropdown && !preview && (
        <Box marginTop={1} marginBottom={1} borderStyle="round" borderColor="cyan" paddingX={1} paddingY={1} width={Math.min(cols - 4, 60)} flexDirection="column">
          <Box marginBottom={1}>
            <Text>
              <Text bold color="cyan">{dropdown.type === "models" ? "Model" : "Provider"}</Text>
              <Text dimColor>  ↑↓ pilih · Enter=pilih · Esc=batal</Text>
            </Text>
          </Box>
          {ddOffset > 0 && (
            <Box><Text dimColor>  ↑ {ddOffset} lagi di atas…</Text></Box>
          )}
          {ddVisible.map((opt, vi) => {
            const idx = ddOffset + vi;
            return (
              <Box key={`${idx}-${opt}`}>
                <Text color={dropdown.selected === idx ? "cyan" : undefined} dimColor={dropdown.selected !== idx}>
                  {dropdown.selected === idx ? "► " : "  "}{opt}{dropdown.type === "models" && opt === session.model ? "  ← aktif" : dropdown.type === "providers" && opt === session.provider ? "  ← aktif" : ""}
                </Text>
              </Box>
            );
          })}
          {ddOffset + ddVisible.length < dropdown.options.length && (
            <Box><Text dimColor>  ↓ {dropdown.options.length - ddOffset - ddVisible.length} lagi di bawah…</Text></Box>
          )}
        </Box>
      )}
      {!preview && (
        <Box marginTop={1} borderStyle="single" borderColor={approval ? "yellow" : running ? "yellow" : "gray"} paddingX={1}>
          <Text color={approval ? "yellow" : running ? "yellow" : "green"}>
            {approval ? "⚡ " : running ? SPIN[spin] + " " : "❯ "}
          </Text>
          <TextInput
            value={input}
            onChange={onInputChange}
            onSubmit={submit}
            focus={approval === null && preview === null}
            placeholder={
              approval ? "Menunggu izin… (y/a/n)" : running ? "Agent bekerja… (Ctrl+C batal)" : "Tulis pesan atau /perintah…"
            }
          />
        </Box>
      )}

      {approval && (
        <Box marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1} flexDirection="column">
          <Box>
            <Text bold color="yellow">Izin terminal </Text>
            <Text>{approval.label}</Text>
          </Box>
          <Box>
            <Text dimColor>[y] sekali   [a] {approval.scope}   [n] tolak</Text>
          </Box>
        </Box>
      )}

      <Box marginTop={0}>
        <Text dimColor>
          ctx ~{usage.tokens.toLocaleString()}/{usage.window.toLocaleString()} ({usage.pct.toFixed(0)}%)
          {"  "}• {session.filesModified.length} files • /help
          {scroll > 0 ? ` • ↑${scroll} (↓ ke bawah)` : ""}
        </Text>
      </Box>

      {isRawModeSupported && <KeyHandler onKey={(inp, key) => {
        if (process.env.SABANA_DEBUG_INPUT) flog("input", `inp=${JSON.stringify(inp)} key=${JSON.stringify(key)}`);
        // Artefak escape dari sequence mouse (klik ditangani parser sendiri).
        if (key.escape && Date.now() - lastMouseAt.current < 120) return;
        // Pratinjau fullscreen: Esc/Ctrl+C menutup; panah scroll; lainnya abaikan.
        // (pakai state `preview` langsung — closure ini dibuat ulang tiap render,
        // jadi selalu segar; ref terpisah rawan lupa di-sync dan bikin Esc mati.)
        if (preview) {
          const act = previewKeyAction(inp, key);
          if (act === "close") {
            closePreview();
            return;
          }
          if (act === "up") {
            setPreviewScroll((s) => Math.max(0, s - SCROLL_STEP));
            return;
          }
          if (act === "down") {
            setPreviewScroll((s) => s + SCROLL_STEP);
            return;
          }
          if (act === "pageup") {
            setPreviewScroll((s) => Math.max(0, s - previewAvail));
            return;
          }
          if (act === "pagedown") {
            setPreviewScroll((s) => s + previewAvail);
            return;
          }
          if (approvalActive.current) {
            const c = inp.toLowerCase();
            if (c === "y") answerApproval("once");
            else if (c === "a") answerApproval("all");
            else if (c === "n") answerApproval("deny");
          }
          return;
        }
        // Dropdown navigation takes priority
        if (dropdown) {
          if (key.upArrow) {
            setDropdown(d => d ? { ...d, selected: Math.max(0, d.selected - 1) } : null);
            return;
          }
          if (key.downArrow) {
            setDropdown(d => d ? { ...d, selected: Math.min(d.options.length - 1, d.selected + 1) } : null);
            return;
          }
          if (key.return) {
            const sel = dropdown.options[dropdown.selected];
            dropdown.onSelect(sel);
            closeDropdown();
            return;
          }
          if (key.escape) {
            closeDropdown();
            return;
          }
          // Ignore other keys when dropdown is open
          return;
        }
        if (approvalActive.current) {
          // Scroll tetap boleh saat box izin tampil (y/a/n tidak bentrok).
          if (key.upArrow) {
            setScrollOffset((s) => s + SCROLL_STEP);
            return;
          }
          if (key.downArrow) {
            setScrollOffset((s) => Math.max(0, s - SCROLL_STEP));
            return;
          }
          if (key.pageUp) {
            setScrollOffset((s) => s + avail);
            return;
          }
          if (key.pageDown) {
            setScrollOffset((s) => Math.max(0, s - avail));
            return;
          }
          if (key.escape) {
            // Allow escape to exit even in approval mode
          }
        }
        // Chat history scrolling (saat tidak ada dropdown/modal).
        // ↑ = lihat riwayat lama, ↓ = kembali ke bawah.
        if (!approvalActive.current && !dropdown) {
          if (key.upArrow) {
            setScrollOffset((s) => s + SCROLL_STEP);
            return;
          }
          if (key.downArrow) {
            setScrollOffset((s) => Math.max(0, s - SCROLL_STEP));
            return;
          }
          if (key.pageUp) {
            setScrollOffset((s) => s + avail);
            return;
          }
          if (key.pageDown) {
            setScrollOffset((s) => Math.max(0, s - avail));
            return;
          }
        }
        if (key.ctrl && inp === "c") {
          // Batal juga menutup box izin (tanpa menyimpan keputusan).
          if (approvalActive.current) answerApproval("cancel");
          if (runningRef.current) {
            agentRef.current?.abortRun();
            push({ kind: "info", tone: "yellow", text: "Membatalkan turn…" });
          } else {
            const a = agentRef.current;
            saveSession({ ...sessionRef.current, approvals: a ? a.getApprovals() : sessionRef.current.approvals });
            exit();
          }
          return;
        }
        // Saat menunggu izin: y = sekali, a = semua serupa, n/Esc = tolak.
        if (approvalActive.current) {
          const c = inp.toLowerCase();
          if (c === "y") answerApproval("once");
          else if (c === "a") answerApproval("all");
          else if (c === "n" || key.escape) answerApproval("deny");
        }
      }} />}
    </Box>
  );
}

function KeyHandler({ onKey }: { onKey: (inp: string, key: { ctrl?: boolean; escape?: boolean; upArrow?: boolean; downArrow?: boolean; return?: boolean; pageUp?: boolean; pageDown?: boolean }) => void }): React.JSX.Element {
  useInput((inp, key) => {
    onKey(inp, key);
  });
  return <></>;
}
