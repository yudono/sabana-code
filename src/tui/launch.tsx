// ─── Fullscreen TUI boot: arg parsing + init + alternate screen ───
// Used by `sabana-code` (the only binary) and `npm run tui` (dev).
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import { createSession, lastSession, loadSession, saveSession } from "../session/store.js";
import { resolveCredentials } from "../auth.js";
import { initEnvFromSettings, loadSettings } from "../settings.js";
import { ensureInitialized } from "../setup.js";
import { flog } from "../utils/filelog.js";
import { setQuiet } from "../utils/logger.js";
import { setMockPlan } from "../llm/mock.js";
import { MOUSE_OFF, MOUSE_ON } from "./mouse.js";

export interface TuiArgs {
  workspace: string;
  modelFlag: string | null;
  providerFlag: string | null;
  maxSteps: number;
  resumeId: string | null;
  cont: boolean;
  promptParts: string[];
  help: boolean;
}

/** Pure arg parsing (unit-tested). */
export function parseTuiArgs(argv: string[]): TuiArgs {
  const args: TuiArgs = {
    workspace: process.cwd(),
    modelFlag: null,
    providerFlag: null,
    maxSteps: 40,
    resumeId: null,
    cont: false,
    promptParts: [],
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") args.help = true;
    else if ((a === "-C" || a === "--workspace") && argv[i + 1]) args.workspace = resolve(argv[++i]);
    else if (a === "--model" && argv[i + 1]) args.modelFlag = argv[++i];
    else if (a === "--provider" && argv[i + 1]) args.providerFlag = argv[++i];
    else if (a === "--max-steps" && argv[i + 1]) {
      const n = parseInt(argv[++i], 10);
      if (!isNaN(n) && n > 0) args.maxSteps = n;
    } else if ((a === "-r" || a === "--resume") && argv[i + 1]) args.resumeId = argv[++i];
    else if (a === "--continue") args.cont = true;
    else if (!a.startsWith("-")) args.promptParts.push(a);
  }
  args.workspace = resolve(args.workspace);
  return args;
}

export function tuiHelp(): string {
  return `
sabana-code — fullscreen TUI coding agent

Usage:
  sabana-code ["initial prompt"] [options]
  sabana-code setup | sabana-code auth ...   (see sabana-code --help)

Options:
  -C, --workspace <path>  Workspace (default: cwd)
  --model <name>           Initial model (default from setup)
  --provider <name>        openai | anthropic | google | groq | together | openrouter | perplexity | ollama | custom | mock
  --max-steps <n>          Max steps per turn (default: 40)
  --resume, -r <id>        Resume a session (prefix ok)
  --continue               Resume the last session
  -h, --help               This help
  -V, --version            Print version

Inside the TUI: /help /new /sessions /projects /resume /models
  /providers /compact /login /logout /agents /agent /skills /todo
  /mcp /checkpoint /checkpoints /rewind /context /tools /clear /quit
`;
}

const ENTER_ALT = "\x1b[?1049h";
const EXIT_ALT = "\x1b[?1049l";

/** Resume hint line printed after TUI exit (pure, unit-tested). */
export function formatResumeHint(sessionId: string, workspaceDir: string): string {
  const short = sessionId.slice(0, 8);
  const ws = /\s/.test(workspaceDir) ? `"${workspaceDir}"` : workspaceDir;
  return `Session saved (${short}). Resume with:\n  sabana-code -r ${short} -C ${ws}`;
}

export async function launchTui(args: TuiArgs): Promise<void> {
  if (args.help) {
    process.stderr.write(tuiHelp());
    return;
  }
  const workspace = args.workspace;

  // Home init + provider setup on first run
  let settings;
  try {
    settings = await ensureInitialized();
  } catch (e) {
    process.stderr.write(`\x1b[31m✗ ${(e as Error).message}\x1b[0m\n`);
    process.exit(1);
  }
  initEnvFromSettings();

  const s = loadSettings();
  const model = args.modelFlag || process.env.SABANA_MODEL || s.default_model || "gpt-4o-mini";
  const provider = args.providerFlag || process.env.SABANA_PROVIDER || s.default_provider || "openai";

  const creds = resolveCredentials(provider);
  if (!creds.apiKey && provider !== "ollama" && provider !== "mock") {
    process.stderr.write(
      `\x1b[31m✗ No API key for ${provider}. Run: sabana-code setup\x1b[0m\n`,
    );
    process.exit(1);
  }
  if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });

  let session = args.resumeId ? loadSession(args.resumeId) : args.cont ? lastSession() : null;
  if ((args.resumeId || args.cont) && !session) {
    process.stderr.write("\x1b[31m✗ Session not found.\x1b[0m\n");
    process.exit(1);
  }
  if (!session) {
    session = createSession(model, provider, workspace);
  } else {
    if (args.modelFlag) session.model = model;
    if (args.providerFlag) session.provider = provider;
    session.workspaceDir = workspace;
  }
  saveSession(session);
  flog("tui", `start session=${session.id.slice(0, 8)} model=${session.model} provider=${session.provider}(${creds.source}) cwd=${workspace}`);

  const stdinTTY = process.stdin.isTTY === true;
  const stdoutTTY = process.stdout.isTTY === true;
  if (!stdinTTY || !stdoutTTY) {
    process.stderr.write("\x1b[31m✗ sabana-code needs an interactive terminal (TTY).\x1b[0m\n");
    process.exit(1);
  }

  const initialPrompt = args.promptParts.length > 0 ? args.promptParts.join(" ") : undefined;
  // Offline demo/smoke hook: mock tool script via env (no LLM key).
  if (provider === "mock" && process.env.SABANA_MOCK_PLAN) {
    try {
      const plan = JSON.parse(process.env.SABANA_MOCK_PLAN) as Array<{ name: string; args: Record<string, unknown> }>;
      if (Array.isArray(plan)) setMockPlan(plan);
    } catch {
      /* abaikan plan rusak */
    }
  }
  // Fullscreen: alternate screen fills the whole terminal
  // and the terminal screen is restored intact on exit.
  // Silence the direct logger so no stray writes pile over the Ink render.
  setQuiet(true);
  process.stdout.write(ENTER_ALT + MOUSE_ON);
  try {
    const app = render(
      <App initialSession={session} workspaceDir={workspace} maxSteps={args.maxSteps} initialPrompt={initialPrompt} />,
      { exitOnCtrlC: false },
    );
    await app.waitUntilExit();
  } finally {
    try {
      process.stdout.write(MOUSE_OFF);
    } catch {
      /* abaikan */
    }
    process.stdout.write(EXIT_ALT);
  }
  // Alt-screen already restored — safe to print the resume hint on the normal terminal.
  process.stdout.write(`\n${formatResumeHint(session.id, workspace)}\n`);
}
