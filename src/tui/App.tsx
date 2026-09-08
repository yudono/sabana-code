// ─── TUI coding agent (Ink): chat + input + live tool-calling ───
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin } from "ink";
import TextInput from "ink-text-input";
import { SingleAgent, type AgentEvent } from "../agent.js";
import { findModel, getContextWindow, listModels, testProviderConnection } from "../llm/models.js";
import { credentialSummary, removeCredential, resolveCredentials, saveCredential } from "../auth.js";
import { listProjects, projectIdFor, projectSessions } from "../projects.js";
import { rpmFromSettings } from "../settings.js";
import { listAgents, loadAgent, runSubAgent } from "../subagents.js";
import { contextUsage } from "../session/context.js";
import {
  createSession,
  lastSession,
  listSessions,
  loadSession,
  saveSession,
  type Session,
} from "../session/store.js";
import { helpText, parseCommand } from "./commands.js";

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; id: string; name: string; args: string; status: "running" | "ok" | "error"; ms?: number }
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

function makeAgent(session: Session, maxSteps: number, onEvent: (ev: AgentEvent) => void): SingleAgent {
  const creds = resolveCredentials(session.provider);
  return new SingleAgent({
    model: session.model,
    provider: session.provider,
    apiKey: creds.apiKey,
    baseUrl: creds.baseUrl,
    maxTokens: 8_192,
    maxSteps,
    autoApprove: true,
    rpm: rpmFromSettings(),
    onEvent,
  });
}

export function App({ initialSession, workspaceDir, maxSteps, initialPrompt }: TuiOptions): React.JSX.Element {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();

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
            args: truncate(JSON.stringify(ev.call.args), 160),
            status: "running",
          });
          break;
        case "tool_end":
          flushStream();
          setItems((prev) =>
            prev.map((it) =>
              it.kind === "tool" && it.id === ev.call.id
                ? { ...it, status: ev.status === "success" ? "ok" : "error", ms: ev.ms }
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
        case "done":
          flushStream();
          break;
      }
    },
    [flushStream, push],
  );

  if (!agentRef.current) {
    agentRef.current = makeAgent(sessionRef.current, maxSteps, handleEvent);
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
        persist({ ...sess, messages, filesModified: result.filesModified });
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
      switch (name) {
        case "help":
          push({ kind: "info", tone: "dim", text: helpText() });
          break;
        case "new": {
          persist(createSession(sess.model, sess.provider, workspaceDir));
          agentRef.current = makeAgent(sessionRef.current, maxSteps, handleEvent);
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
            });
            push({ kind: "assistant", text: sub.text.trim() || "(sub-agent tanpa jawaban teks)" });
            persist({
              ...sess,
              messages: [
                ...sess.messages,
                { role: "user" as const, content: `[sub-agent ${profile.name}] ${task}` },
                { role: "assistant" as const, content: sub.text },
              ],
              filesModified: [...new Set([...sess.filesModified, ...sub.files])],
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
          agentRef.current = makeAgent(target, maxSteps, handleEvent);
          setCutoff(itemsRef.current.length + 1);
          push({ kind: "info", tone: "green", text: `Melanjutkan session ${target.id.slice(0, 8)} (${target.messages.length} pesan).` });
          for (const it of rebuildItems(target.messages)) push(it);
          break;
        }
        case "model": {
          if (args.length === 0) {
            const known = listModels(sess.provider);
            push({
              kind: "info",
              tone: "dim",
              text: [`Model aktif: ${sess.model} (window ${getContextWindow(sess.model, sess.provider).toLocaleString()} token)`, "Katalog:", ...known.map((m) => `  ${m.id} — ${m.description}`), "Ganti: /model <nama>"].join("\n"),
            });
            break;
          }
          const id = args[0];
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
          break;
        }
        case "provider": {
          if (args.length === 0) {
            push({ kind: "info", tone: "dim", text: `Provider aktif: ${sess.provider}\nPilihan: openai, anthropic, google, ollama, custom, mock\nGanti: /provider <nama>  (kredensial: env → ~/sabana-code/settings.json)` });
            break;
          }
          const p = args[0].toLowerCase();
          if (!["openai", "anthropic", "google", "ollama", "custom", "mock"].includes(p)) {
            push({ kind: "info", tone: "red", text: `Provider tak dikenal: ${p}` });
            break;
          }
          const creds = resolveCredentials(p);
          if (!creds.apiKey && p !== "ollama" && p !== "mock") {
            push({ kind: "info", tone: "red", text: `Provider ${p} butuh API key — /login ${p} <key> atau sabana-code auth login ${p}. Dibatalkan.` });
            break;
          }
          agent.setModelProvider(sess.model, p, creds.apiKey, creds.baseUrl);
          persist({ ...sess, provider: p });
          push({ kind: "info", tone: "green", text: `Provider → ${p}. Menguji koneksi…` });
          const test = await testProviderConnection(p);
          push({ kind: "info", tone: test.ok ? "green" : "red", text: test.detail });
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
          if (!p || !key || !["openai", "anthropic", "google", "ollama", "custom"].includes(p)) {
            push({ kind: "info", tone: "red", text: "Pakai: /login <openai|anthropic|google|ollama|custom> <api-key> [base-url]" });
            break;
          }
          saveCredential(p, key, base || "");
          push({ kind: "info", tone: "green", text: `Kredensial ${p} tersimpan global. Kini bisa jalan dari direktori mana pun.` });
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
    [exit, handleEvent, maxSteps, persist, push, workspaceDir],
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
  const visible = items.slice(cutoff).slice(-200);
  const projectName = workspaceDir.split("/").filter(Boolean).pop() || workspaceDir;

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Box>
          <Text bold color="cyan">sabana-code</Text>
          <Text bold>  {projectName}</Text>
          <Text dimColor>  {session.id.slice(0, 8)} • {session.model}/{session.provider}</Text>
        </Box>
        <Box><Text dimColor>{workspaceDir}</Text></Box>
      </Box>

      <Box flexDirection="column" marginTop={1}>
        {visible.map((it, i) => (
          <Box key={cutoff + "-" + i} marginBottom={it.kind === "assistant" ? 1 : 0}>
            {it.kind === "user" && (
              <Text><Text bold color="green">❯ </Text><Text>{it.text}</Text></Text>
            )}
            {it.kind === "assistant" && <Text>{it.text}</Text>}
            {it.kind === "tool" && (
              <Text dimColor>
                {it.status === "running" ? "⏳" : it.status === "ok" ? "✓" : "✗"} {it.name} {it.args}
                {it.ms !== undefined ? ` (${it.ms}ms)` : ""}
              </Text>
            )}
            {it.kind === "info" && (
              <Text color={it.tone === "dim" ? undefined : it.tone} dimColor={it.tone === "dim"}>{it.text}</Text>
            )}
          </Box>
        ))}
        {stream ? (
          <Box><Text>{stream}▍</Text></Box>
        ) : null}
      </Box>

      <Box marginTop={1} borderStyle="single" borderColor={running ? "yellow" : "gray"} paddingX={1}>
        <Text color={running ? "yellow" : "green"}>{running ? SPIN[spin] + " " : "❯ "}</Text>
        <TextInput value={input} onChange={setInput} onSubmit={submit} placeholder={running ? "Agent bekerja… (Ctrl+C batal)" : "Tulis pesan atau /perintah…"} />
      </Box>

      <Box marginTop={0}>
        <Text dimColor>
          ctx ~{usage.tokens.toLocaleString()}/{usage.window.toLocaleString()} ({usage.pct.toFixed(0)}%)
          {"  "}• {session.filesModified.length} files • /help
        </Text>
      </Box>

      {isRawModeSupported && <KeyHandler onCtrlC={() => {
        if (runningRef.current) {
          agentRef.current?.abortRun();
          push({ kind: "info", tone: "yellow", text: "Membatalkan turn…" });
        } else {
          saveSession(sessionRef.current);
          exit();
        }
      }} />}
    </Box>
  );
}

function KeyHandler({ onCtrlC }: { onCtrlC: () => void }): React.JSX.Element {
  useInput((inp, key) => {
    if (key.ctrl && inp === "c") onCtrlC();
  });
  return <></>;
}
