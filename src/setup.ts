// ─── Setup wizard + inisialisasi ~/sabana-code/ saat pertama jalan ───
// Alur: install → buka sabana-code → folder ~/sabana-code/ dibuat
// (sessions/, logs/, settings.json, sabana.db) → user sets up the main provider
// (openai/anthropic/google/ollama/custom) + API key + model → siap dipakai.
import * as readline from "node:readline";
import { getDb } from "./db.js";
import { ensureHome, sabanaHome } from "./home.js";
import {
  PROVIDER_PRESETS,
  SUPPORTED_PROVIDERS,
  isSettingsComplete,
  loadSettings,
  saveSettings,
  settingsPath,
  type SettingsFile,
  type ProviderConfig,
} from "./settings.js";
import { flog } from "./utils/filelog.js";
import { ensureMcpConfigSeed } from "./mcp.js";

function ask(rl: readline.Interface, q: string): Promise<string> {
  return new Promise((res) => rl.question(q, (a) => res(a.trim())));
}

function askHidden(rl: readline.Interface, q: string): Promise<string> {
  process.stdout.write(q);
  const mutable = rl as unknown as { _writeToOutput: (s: string) => void };
  const orig = mutable._writeToOutput.bind(rl);
  mutable._writeToOutput = () => process.stdout.write("*");
  return new Promise((res) => {
    rl.question("", (a) => {
      mutable._writeToOutput = orig;
      process.stdout.write("\n");
      res(a.trim());
    });
  });
}

/** Interactive wizard: provider → URL → key → model → (optional) Tavily. */
export async function runSetupWizard(): Promise<SettingsFile> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const names = SUPPORTED_PROVIDERS.filter((p) => p !== "mock");
  try {
    process.stdout.write("\n=== sabana-code setup ===\nPick the main provider:\n");
    names.forEach((p, i) => {
      process.stdout.write(`  [${i + 1}] ${p} — ${PROVIDER_PRESETS[p].hint}\n`);
    });
    let provider = "";
    while (!provider) {
      const ans = await ask(rl, `Provider [1-${names.length}] (default 1): `);
      if (!ans) provider = names[0];
      else {
        const idx = parseInt(ans, 10);
        if (!isNaN(idx) && idx >= 1 && idx <= names.length) provider = names[idx - 1];
        else if (names.includes(ans.toLowerCase())) provider = ans.toLowerCase();
        else process.stdout.write("  Invalid choice.\n");
      }
    }
    const preset = PROVIDER_PRESETS[provider];

    let baseUrl = preset.baseUrl;
    if (provider === "custom") {
      while (!baseUrl) {
        baseUrl = await ask(rl, "OpenAI-compatible base URL (e.g. https://your-provider.com/v1): ");
      }
    } else {
      const custom = await ask(rl, `Base URL [default: ${preset.baseUrl}]: `);
      if (custom) baseUrl = custom;
    }

    let apiKey = "";
    if (preset.needsKey) {
      while (!apiKey) {
        apiKey = await askHidden(rl, "API key (hidden input): ");
        if (!apiKey) process.stdout.write("  API key is required.\n");
      }
    }

    const modelAns = await ask(rl, `Model [default: ${preset.model || "-"}]: `);
    const model = modelAns || preset.model;

    const tavily = await ask(rl, "Tavily API key for web_search (optional, Enter to skip): ");

    const s = loadSettings();
    s.default_provider = provider;
    s.default_model = model;
    s.providers[provider] = {
      baseUrl,
      apiKey,
      model,
      maxTokens: 8192,
    };
    if (tavily) s.tavily_api_key = tavily;
    saveSettings(s);
    flog("setup", `provider=${provider} model=${model}`);
    process.stdout.write(`\n✓ Saved to ${settingsPath()}\n`);
    process.stdout.write(`  Provider: ${provider}\n  Model:    ${model || "(default provider)"}\n`);
    return s;
  } finally {
    rl.close();
  }
}

/**
 * Full init when the app opens:
 * 1. Create ~/sabana-code/ (sessions/, logs/, sabana.db via getDb()).
 * 2. Create default settings.json if missing.
 * 3. If setup is incomplete → wizard (TTY) or friendly error (non-TTY).
 */
export async function ensureInitialized(): Promise<SettingsFile> {
  ensureHome();
  getDb(); // pastikan sabana.db + tabel ada
  ensureMcpConfigSeed(); // create sample ~/sabana-code/mcp.json if missing
  let s = loadSettings();
  if (!isSettingsComplete(s)) {
    if (!process.stdin.isTTY) {
      throw new Error(
        `Setup incomplete (${settingsPath()}). Run 'sabana-code setup' in an interactive terminal.`,
      );
    }
    process.stdout.write(`\nWelcome to sabana-code! Home: ${sabanaHome()}\n`);
    process.stdout.write("First-time setup — pick your main LLM provider.\n");
    s = await runSetupWizard();
  }
  return s;
}
