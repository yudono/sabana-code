#!/usr/bin/env node
// sabana-code — TUI coding agent fullscreen (satu-satunya runnable).
// Runs from any directory; sessions, logs, sqlite db, and
// credentials live in ~/sabana-code/.
import * as readline from "node:readline";
import { credentialSummary, removeCredential, saveCredential } from "./auth.js";
import { ensureHome, sabanaHome } from "./home.js";
import { SUPPORTED_PROVIDERS, initEnvFromSettings } from "./settings.js";
import { runSetupWizard } from "./setup.js";
import { launchTui, parseTuiArgs } from "./tui/launch.js";
import { err, ok } from "./utils/logger.js";
import { flog } from "./utils/filelog.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Package version (for `sabana-code --version`, build diagnosis). */
export function packageVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, "..", "package.json"), join(process.cwd(), "package.json")];
  for (const p of candidates) {
    try {
      if (existsSync(p)) {
        const v = (JSON.parse(readFileSync(p, "utf-8")) as { version?: unknown }).version;
        if (typeof v === "string" && v) return v;
      }
    } catch {
      /* try the next candidate */
    }
  }
  return "unknown";
}

function help(): void {
  process.stderr.write(`
sabana-code — fullscreen TUI coding agent

Usage:
  sabana-code ["initial prompt"] [options]
  sabana-code setup                    Initial / repeat main provider setup
  sabana-code auth login <provider>    Save API key to ~/sabana-code/ (global)
  sabana-code auth logout <provider>   Remove stored API key
  sabana-code auth list                Show credential status

Options:
  -C, --workspace <path>   Workspace dir (default: cwd)
  --model <name>            Model (default from setup)
  --provider <name>         openai | anthropic | google | groq | together | openrouter | perplexity | ollama | custom | mock
  --max-steps <n>           Max steps per turn (default: 40)
  --resume, -r <id>        Resume a session (prefix ok)
  --continue               Resume the last session
  -h, --help               This help
  -V, --version            Print version

First setup creates ~/sabana-code/ (sessions/, logs/, settings.json, sabana.db)
then asks for main provider + API key + model. No .env.
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
    const key = await askHidden(`API key for ${provider} (hidden input): `);
    if (!key) {
      err("Empty key — cancelled.");
      process.exit(1);
    }
    saveCredential(provider, key);
    ok(`Saved in ${sabanaHome()} (settings.json). Works from anywhere now.`);
    flog("auth", `login ${provider}`);
  } else if (action === "logout") {
    if (removeCredential(provider)) ok(`Credential for ${provider} removed.`);
    else err(`No stored credential for ${provider}.`);
  } else {
    err("Action: login | logout | list");
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    help();
    process.exit(0);
  }
  if (argv.includes("-V") || argv.includes("--version")) {
    process.stdout.write(`sabana-code ${packageVersion()}\n`);
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
