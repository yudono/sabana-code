#!/usr/bin/env node
// sabana-code — TUI coding agent fullscreen (satu-satunya runnable).
// Dijalankan dari direktori mana pun; session, log, db sqlite, dan
// credentials tersimpan di ~/sabana-code/.
import * as readline from "node:readline";
import { credentialSummary, removeCredential, saveCredential } from "./auth.js";
import { ensureHome, sabanaHome } from "./home.js";
import { SUPPORTED_PROVIDERS, initEnvFromSettings } from "./settings.js";
import { runSetupWizard } from "./setup.js";
import { launchTui, parseTuiArgs } from "./tui/launch.js";
import { err, ok } from "./utils/logger.js";
import { flog } from "./utils/filelog.js";

function help(): void {
  process.stderr.write(`
sabana-code — TUI coding agent (fullscreen)

Usage:
  sabana-code ["prompt awal"] [options]
  sabana-code setup                    Setup awal / ulang provider utama
  sabana-code auth login <provider>    Simpan API key ke ~/sabana-code/ (global)
  sabana-code auth logout <provider>   Hapus API key tersimpan
  sabana-code auth list                Lihat status kredensial

Options:
  -C, --workspace <path>   Workspace dir (default: cwd)
  --model <name>            Model (default dari setup)
  --provider <name>         openai | anthropic | google | groq | together | openrouter | perplexity | ollama | custom | mock
  --max-steps <n>           Maks step per turn (default: 40)
  --resume, -r <id>        Lanjutkan session (dukung prefix)
  --continue               Lanjutkan session terakhir
  -h, --help                Bantuan ini

Setup pertama membuat ~/sabana-code/ (sessions/, logs/, settings.json, sabana.db)
lalu meminta provider utama + API key + model. Tanpa .env.
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
      const label = c.source === "env" ? "env" : c.source === "global" ? "~/sabana-code" : "-";
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
    ok(`Tersimpan di ${sabanaHome()} (settings.json). Kini bisa jalan dari mana pun.`);
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
  if (argv.includes("-h") || argv.includes("--help")) {
    help();
    process.exit(0);
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
  // Default: TUI fullscreen.
  await launchTui(parseTuiArgs(argv));
}

main().catch((e) => {
  err(`Fatal: ${(e as Error).message}`);
  process.exit(1);
});
