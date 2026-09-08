#!/usr/bin/env node
// sabana-code TUI — coding agent interaktif (chat + tool-calling + sessions).
//   tsx src/tui/main.tsx ["prompt awal"] [-C workspace] [--model n] [--provider n]
//                          [--max-steps n] [--resume <id>] [--continue]
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import React from "react";
import { render } from "ink";
import { App } from "./App.js";
import { createSession, lastSession, loadSession, saveSession } from "../session/store.js";
import { resolveCredentials } from "../auth.js";
import { initEnvFromSettings } from "../settings.js";
import { ensureInitialized } from "../setup.js";
import { flog } from "../utils/filelog.js";

function help(): void {
  process.stderr.write(`
sabana-code TUI — coding agent interaktif

Usage:
  tsx src/tui/main.tsx ["prompt awal"] [options]

Options:
  -C, --workspace <path>  Workspace (default: cwd)
  --model <name>           Model awal (default dari setup)
  --provider <name>        openai | anthropic | google | ollama | custom | mock
  --max-steps <n>          Maks step per turn (default: 40)
  --resume <id>            Lanjutkan session (dukung prefix)
  --continue               Lanjutkan session terakhir
  -h, --help               Bantuan ini

Di dalam TUI: /help /new /sessions /projects /resume /model /provider
  /login /logout /agents /agent /context /tools /clear /quit
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  let workspace = process.cwd();
  let modelFlag: string | null = null;
  let providerFlag: string | null = null;
  let maxSteps = 40;
  let resumeId: string | null = null;
  let cont = false;
  let promptParts: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      help();
      process.exit(0);
    }     else if ((a === "-C" || a === "--workspace") && argv[i + 1]) workspace = resolve(argv[++i]);
    else if (a === "--model" && argv[i + 1]) modelFlag = argv[++i];
    else if (a === "--provider" && argv[i + 1]) providerFlag = argv[++i];
    else if (a === "--max-steps" && argv[i + 1]) maxSteps = parseInt(argv[++i], 10);
    else if (a === "--resume" && argv[i + 1]) resumeId = argv[++i];
    else if (a === "--continue") cont = true;
    else if (!a.startsWith("-")) promptParts.push(a);
  }
  workspace = resolve(workspace);

  // Inisialisasi home + setup provider bila pertama kali
  let settings;
  try {
    settings = await ensureInitialized();
  } catch (e) {
    process.stderr.write(`\x1b[31m✗ ${(e as Error).message}\x1b[0m\n`);
    process.exit(1);
  }
  initEnvFromSettings();

  const model = modelFlag || process.env.SABANA_MODEL || settings.env.SABANA_MODEL || "gpt-4o-mini";
  const provider = providerFlag || process.env.SABANA_PROVIDER || settings.env.SABANA_PROVIDER || "openai";

  const creds = resolveCredentials(provider);
  if (!creds.apiKey && provider !== "ollama" && provider !== "mock") {
    process.stderr.write(
      `\x1b[31m✗ Tidak ada API key untuk ${provider}. Jalankan: sabana-code setup\x1b[0m\n`,
    );
    process.exit(1);
  }
  if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });

  let session = resumeId ? loadSession(resumeId) : cont ? lastSession() : null;
  if ((resumeId || cont) && !session) {
    process.stderr.write("\x1b[31m✗ Session tidak ditemukan.\x1b[0m\n");
    process.exit(1);
  }
  if (!session) {
    session = createSession(model, provider, workspace);
  } else {
    // Flag CLI meng-override session yang dilanjutkan
    if (modelFlag) session.model = model;
    if (providerFlag) session.provider = provider;
    session.workspaceDir = workspace;
  }
  saveSession(session);
  flog("tui", `start session=${session.id.slice(0, 8)} model=${session.model} provider=${session.provider}(${creds.source}) cwd=${workspace}`);

  if (!process.stdin.isTTY) {
    process.stderr.write("\x1b[31m✗ TUI butuh terminal interaktif (TTY). Untuk sekali jalan tanpa TUI, pakai: sabana-code \"<prompt>\"\x1b[0m\n");
    process.exit(1);
  }

  const initialPrompt = promptParts.length > 0 ? promptParts.join(" ") : undefined;
  const app = render(
    <App initialSession={session} workspaceDir={workspace} maxSteps={maxSteps} initialPrompt={initialPrompt} />,
  );
  await app.waitUntilExit();
}

main().catch((e) => {
  process.stderr.write(`\x1b[31mFatal: ${(e as Error).message}\x1b[0m\n`);
  process.exit(1);
});
