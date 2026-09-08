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
import { summarizeCall } from "../tools/summary.js";
import type { PermissionAsker, PermissionRequest, AskerVerdict } from "../utils/permissions.js";
import { listAgents, loadAgent, runSubAgent } from "../subagents.js";
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
  | { kind: "tool"; id: string; summary: string; detail?: string; status: "running" | "ok" | "error" }
  | { kind: "info"; tone: "dim" | "yellow" | "red" | "green"; text: string };

export interface TuiOptions {
  initialSession: Session;
  workspaceDir: string;
  maxSteps: number;
  initialPrompt?: string;
}

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

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

/** Perkiraan tinggi item dalam baris terminal (sudah termasuk margin). */
export function itemRows(it: ChatItem, cols: number): number {
  const w = Math.max(20, cols - 4);
  const lines = itemText(it)
    .split("\n")
    .reduce((n, ln) => n + Math.max(1, Math.ceil(cellWidth(ln) / w)), 0);
  return lines + (it.kind === "assistant" ? 1 : 0); // marginBottom
}

/**
 * Potong item raksasa (assistant/info): ambil ekornya saja agar muat maxRows.
 * Mencegah satu item mendorong seluruh layar (chat tak pernah kosong).
 * Untuk info: pertahankan HEADER (baris pertama) agar judul tidak hilang.
 */
export function sliceItemTail(it: ChatItem, maxRows: number, cols: number): ChatItem {
  if (it.kind !== "assistant" && it.kind !== "info") return it;
  const budget = Math.max(1, maxRows - 1); // sisakan 1 baris penanda
  const w = Math.max(20, cols - 4);
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
  // assistant: tetap ambil ekor
  let used = 1; // marginBottom
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

/** Tampilkan prompt asli, bukan blob konteks awal ("## USER REQUEST\n<prompt>..."). */
function displayPrompt(content: string): string {
  const lines = content.split("\n");
  const reqIdx = lines.findIndex((l) => l.trim() === "## USER REQUEST");
  const raw = reqIdx >= 0 ? lines.slice(reqIdx + 1).join("\n").trim() : content;
  return truncate(raw || content);
}

function rebuildItems(messages: Session["messages"]): ChatItem[] {
  const out: ChatItem[] = [];
  for (const m of messages) {
    if (m.role === "user") out.push({ kind: "user", text: displayPrompt(m.content) });
    else if (m.role === "assistant" && m.content.trim()) out.push({ kind: "assistant", text: m.content });
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
  const [items, setItems] = useState<ChatItem[]>(() => [
    { kind: "info", tone: "dim", text: "sabana-code TUI — ketik pesan untuk mulai, /help untuk perintah, Ctrl+C untuk batal/keluar." },
    ...(initialSession.messages.length > 0
      ? [
          {
            kind: "info" as const,
            tone: "dim" as const,
            text: `Melanjutkan session ${initialSession.id.slice(0, 8)} (${initialSession.messages.length} pesan).`,
          },
          ...rebuildItems(initialSession.messages),
        ]
      : []),
  ]);
  const [input, setInput] = useState("");
  const [running, setRunning] = useState(false);
  const [stream, setStream] = useState("");
  const [cutoff, setCutoff] = useState(0);
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
            summary: summarizeCall(ev.call.name, ev.call.args),
            status: "running",
          });
          break;
        case "tool_end":
          flushStream();
          setItems((prev) =>
            prev.map((it) =>
              it.kind === "tool" && it.id === ev.call.id
                ? { ...it, status: ev.status === "success" ? "ok" : "error", detail: ev.summary }
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
          const lines = helpText().split("\n");
          // Reverse so important commands stay visible in viewport
          for (const line of lines.reverse()) {
            push({ kind: "info", tone: "dim", text: line });
          }
          break;
        }
        case "new": {
          persist(createSession(sess.model, sess.provider, workspaceDir));
          agentRef.current = makeAgent(sessionRef.current, maxSteps, handleEvent, asker);
          setCutoff(itemsRef.current.length + 1);
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
      const cmd = parseCommand(text);
      if (cmd) void execCommand(cmd.name, cmd.args);
      else void runTurn(text);
    },
    [execCommand, runTurn],
  );

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

  const usage = contextUsage(session.messages, session.model, session.provider);
  const visible = items.slice(cutoff).slice(-300);
  const projectName = workspaceDir.split("/").filter(Boolean).pop() || workspaceDir;
  const cols = Math.max(40, size.columns);
  const rows = Math.max(12, size.rows);

  // Viewport manual arah normal: hanya item ekor yang muat yang dirender,
  // item lama keluar dari atas. Tanpa column-reverse/overflow eksotis.
  const CHROME_ROWS = 4 + 1 + 3 + 1; // header + margin + input + status
  const approvalRows = approval ? 5 : 0;
  const avail = Math.max(5, rows - CHROME_ROWS - approvalRows - 2);
  const feed: ChatItem[] = stream ? [...visible, { kind: "assistant", text: `${stream}▍` }] : visible;
  let start = feed.length;
  let used = 0;
  while (start > 0) {
    const h = itemRows(feed[start - 1], cols);
    if (used + h > avail) break;
    used += h;
    start--;
  }
  let windowed = feed.slice(start);
  // Satu item raksasa melebihi layar: tampilkan ekornya, jangan kosongkan chat.
  if (windowed.length === 1 && itemRows(windowed[0], cols) > avail) {
    windowed = [sliceItemTail(windowed[0], avail, cols)];
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
        {windowed.map((it, ri) => {
          const isStream = stream !== "" && start + ri === feed.length - 1;
          return (
            <Box key={isStream ? "__stream" : `${cutoff}-${start + ri}`} marginBottom={it.kind === "assistant" ? 1 : 0}>
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
              {it.kind === "info" && (
                <Text color={it.tone === "dim" ? undefined : it.tone} dimColor={it.tone === "dim"}>{it.text}</Text>
              )}
            </Box>
          );
        })}
      </Box>

      {dropdown && (
        <Box marginTop={1} marginBottom={1} borderStyle="round" borderColor="cyan" paddingX={1} paddingY={1} width={Math.min(cols - 4, 60)}>
          <Box marginBottom={1}>
            <Text bold color="cyan">{dropdown.type === "models" ? "Model" : "Provider"}</Text>
            <Text dimColor>↑↓ pilih  Enter=pilih  Esc=batal</Text>
          </Box>
          {dropdown.options.map((opt, idx) => (
            <Box key={opt} marginTop={idx === 0 ? 0 : 1}>
              <Text color={dropdown.selected === idx ? "cyan" : "white"} dimColor={dropdown.selected !== idx}>
                {dropdown.selected === idx ? "► " : "  "}{opt}{dropdown.type === "models" && opt === session.model ? "  ← aktif" : dropdown.type === "providers" && opt === session.provider ? "  ← aktif" : ""}
              </Text>
            </Box>
          ))}
        </Box>
      )}
      <Box marginTop={1} borderStyle="single" borderColor={approval ? "yellow" : running ? "yellow" : "gray"} paddingX={1}>
        <Text color={approval ? "yellow" : running ? "yellow" : "green"}>
          {approval ? "⚡ " : running ? SPIN[spin] + " " : "❯ "}
        </Text>
        <TextInput
          value={input}
          onChange={setInput}
          onSubmit={submit}
          focus={approval === null}
          placeholder={
            approval ? "Menunggu izin… (y/a/n)" : running ? "Agent bekerja… (Ctrl+C batal)" : "Tulis pesan atau /perintah…"
          }
        />
      </Box>

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
        </Text>
      </Box>

      {isRawModeSupported && <KeyHandler onKey={(inp, key) => {
        if (process.env.SABANA_DEBUG_INPUT) flog("input", `inp=${JSON.stringify(inp)} key=${JSON.stringify(key)}`);
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

function KeyHandler({ onKey }: { onKey: (inp: string, key: { ctrl?: boolean; escape?: boolean; upArrow?: boolean; downArrow?: boolean; return?: boolean; }) => void }): React.JSX.Element {
  useInput((inp, key) => {
    onKey(inp, key);
  });
  return <></>;
}
