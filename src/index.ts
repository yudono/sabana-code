#!/usr/bin/env node
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// sabana-code — single-agent coding CLI (seperti claude-code / opencode)
// Bisa dipanggil global dari direktori mana pun; session, log, db sqlite,
// dan credentials tersimpan di ~/sabana-code/.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as readline from "node:readline";
import { SingleAgent } from "./agent.js";
import { credentialSummary, removeCredential, resolveCredentials, saveCredential } from "./auth.js";
import { ensureHome, sabanaHome } from "./home.js";
import { SUPPORTED_PROVIDERS, initEnvFromSettings, rpmFromSettings } from "./settings.js";
import { ensureInitialized, runSetupWizard } from "./setup.js";
import { err, log, ok } from "./utils/logger.js";
import { flog } from "./utils/filelog.js";

function help(): void {
  process.stderr.write(`
sabana-code — coding agent CLI (single-agent + tool calling)

Usage:
  sabana-code "<prompt>" [options]
  sabana-code setup                    Setup awal / ulang provider utama
  sabana-code auth login <provider>    Simpan API key ke ~/sabana-code/ (global)
  sabana-code auth logout <provider>   Hapus API key tersimpan
  sabana-code auth list                Lihat status kredensial

Options:
  -C, --workspace <path>   Workspace dir (default: cwd)
  --model <name>            Model (default dari setup)
  --provider <name>         openai | anthropic | google | ollama | custom | mock
  --max-steps <n>           Maksimal agent steps (default: 40)
  --auto-approve            Setujui semua tool tanpa prompt
  -h, --help                Bantuan ini

Setup pertama membuat ~/sabana-code/ (sessions/, logs/, settings.json, sabana.db)
lalu meminta provider utama + API key + model. Tanpa .env.

Contoh:
  sabana-code setup
  sabana-code "buatkan web hello world dengan vite + tailwind"
  sabana-code "perbaiki bug login di src/auth.ts" -C ./my-project --auto-approve
`);
}

function askHidden(question: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const rl = readline.createInterface({ input: process.stdin });
    return new Promise((res) => {
      process.stdout.write(question);
      rl.on("line", (line) => {
        rl.close();
        res(line.trim());
      });
    });
  }
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(question);
    const mutable = rl as unknown as { _writeToOutput: (s: string) => void };
    mutable._writeToOutput = () => process.stdout.write("*");
    rl.on("line", (line) => {
      (process.stdout as NodeJS.WriteStream).write("\n");
      rl.close();
      res(line.trim());
    });
  });
}

async function authCmd(args: string[]): Promise<void> {
  ensureHome();
  const [action, provider] = args;
  if (action === "list" || !action) {
    for (const c of credentialSummary()) {
      const label = c.source === "env" ? "env/.env" : c.source === "global" ? "~/sabana-code" : "-";
      process.stdout.write(`${c.provider.padEnd(10)} ${label}\n`);
    }
    return;
  }
  if (!provider || !SUPPORTED_PROVIDERS.includes(provider) || provider === "mock") {
    err(`Provider: ${SUPPORTED_PROVIDERS.filter((p) => p !== "mock").join(" | ")}`);
    process.exit(1);
  }
  if (action === "login") {
    const key = await askHidden(`API key untuk ${provider} (input disembunyikan): `);
    if (!key) {
      err("Key kosong — dibatalkan.");
      process.exit(1);
    }
    saveCredential(provider, key);
    ok(`Tersimpan di ${sabanaHome()} (sabana.db). Kini bisa jalan dari mana pun.`);
    flog("auth", `login ${provider}`);
  } else if (action === "logout") {
    if (removeCredential(provider)) ok(`Kredensial ${provider} dihapus.`);
    else err(`Tidak ada kredensial ${provider} yang tersimpan.`);
  } else {
    err("Aksi: login | logout | list");
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    help();
    process.exit(argv.length === 0 ? 1 : 0);
  }
  if (argv[0] === "auth") {
    initEnvFromSettings();
    await authCmd(argv.slice(1));
    return;
  }
  if (argv[0] === "setup") {
    await runSetupWizard();
    return;
  }

  // Inisialisasi home + setup provider bila pertama kali
  let settings;
  try {
    settings = await ensureInitialized();
  } catch (e) {
    err((e as Error).message);
    process.exit(1);
  }
  initEnvFromSettings();

  let prompt = "";
  let model = process.env.SABANA_MODEL || settings.env.SABANA_MODEL || "gpt-4o-mini";
  let provider = process.env.SABANA_PROVIDER || settings.env.SABANA_PROVIDER || "openai";
  let maxSteps = 40;
  let workspace = process.cwd();
  let autoApprove = process.env.AGENT_AUTO_APPROVE === "true";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--model" && argv[i + 1]) model = argv[++i];
    else if (a === "--provider" && argv[i + 1]) provider = argv[++i];
    else if (a === "--max-steps" && argv[i + 1]) maxSteps = parseInt(argv[++i], 10);
    else if ((a === "-C" || a === "--workspace") && argv[i + 1]) workspace = resolve(argv[++i]);
    else if (a === "--auto-approve") autoApprove = true;
    else if (!a.startsWith("-") && !prompt) prompt = a;
    else if (!a.startsWith("-")) prompt += " " + a;
  }

  if (!prompt) {
    err("Prompt kosong.");
    process.exit(1);
  }

  const creds = resolveCredentials(provider);
  if (!creds.apiKey && provider !== "ollama" && provider !== "mock") {
    err(`Tidak ada API key untuk ${provider}. Jalankan: sabana-code setup (atau sabana-code auth login ${provider})`);
    process.exit(1);
  }
  if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });

  ensureHome();
  flog("cli", `start model=${model} provider=${provider}(${creds.source}) cwd=${workspace} prompt=${prompt.slice(0, 120)}`);
  log(`prompt: "${prompt.slice(0, 120)}" (key: ${creds.source})`);
  const agent = new SingleAgent({
    model,
    provider,
    apiKey: creds.apiKey,
    baseUrl: creds.baseUrl,
    maxTokens: parseInt((process.env.SABANA_MAX_TOKEN || settings.env.SABANA_MAX_TOKEN || "8192").replace(/_/g, ""), 10),
    maxSteps,
    autoApprove,
    rpm: rpmFromSettings(),
  });
  process.on("SIGINT", () => {
    log("membatalkan...");
    agent.abortRun();
  });

  const result = await agent.run(prompt, workspace);

  if (result.success) {
    ok(`selesai: ${result.steps} steps, ${result.filesModified.length} file diubah`);
    if (result.filesModified.length) log(`files: ${result.filesModified.join(", ")}`);
  } else {
    err("gagal / dibatalkan.");
  }
  flog("cli", `end success=${result.success} steps=${result.steps} files=${result.filesModified.length}`);
  writeFileSync(
    join(workspace, "sabana-code-result.json"),
    JSON.stringify(
      { prompt, success: result.success, steps: result.steps, files: result.filesModified, at: new Date().toISOString() },
      null,
      2,
    ),
  );
  process.exit(result.success ? 0 : 1);
}

main().catch((e) => {
  err(`Fatal: ${(e as Error).message}`);
  process.exit(1);
});
