// ─── Setup wizard + inisialisasi ~/sabana-code/ saat pertama jalan ───
// Alur: install → buka sabana-code → folder ~/sabana-code/ dibuat
// (sessions/, logs/, settings.json, sabana.db) → user setup provider utama
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

/** Wizard interaktif: pilih provider → URL → key → model → (opsional) Tavily. */
export async function runSetupWizard(): Promise<SettingsFile> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const names = SUPPORTED_PROVIDERS.filter((p) => p !== "mock");
  try {
    process.stdout.write("\n=== sabana-code setup ===\nPilih provider utama:\n");
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
        else process.stdout.write("  Pilihan tidak valid.\n");
      }
    }
    const preset = PROVIDER_PRESETS[provider];

    let baseUrl = preset.baseUrl;
    if (provider === "custom") {
      while (!baseUrl) {
        baseUrl = await ask(rl, "Base URL OpenAI-compatible (mis. https://providerkamu.com/v1): ");
      }
    } else {
      const custom = await ask(rl, `Base URL [default: ${preset.baseUrl}]: `);
      if (custom) baseUrl = custom;
    }

    let apiKey = "";
    if (preset.needsKey) {
      while (!apiKey) {
        apiKey = await askHidden(rl, "API key (input disembunyikan): ");
        if (!apiKey) process.stdout.write("  API key wajib diisi.\n");
      }
    }

    const modelAns = await ask(rl, `Model [default: ${preset.model || "-"}]: `);
    const model = modelAns || preset.model;

    const tavily = await ask(rl, "Tavily API key untuk web_search (opsional, Enter lewati): ");

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
    process.stdout.write(`\n✓ Tersimpan di ${settingsPath()}\n`);
    process.stdout.write(`  Provider: ${provider}\n  Model:    ${model || "(default provider)"}\n`);
    return s;
  } finally {
    rl.close();
  }
}

/**
 * Inisialisasi lengkap saat aplikasi dibuka:
 * 1. Buat ~/sabana-code/ (sessions/, logs/, sabana.db via getDb()).
 * 2. Buat settings.json default bila belum ada.
 * 3. Bila setup belum lengkap → wizard (TTY) atau error ramah (non-TTY).
 */
export async function ensureInitialized(): Promise<SettingsFile> {
  ensureHome();
  getDb(); // pastikan sabana.db + tabel ada
  let s = loadSettings();
  if (!isSettingsComplete(s)) {
    if (!process.stdin.isTTY) {
      throw new Error(
        `Setup belum lengkap (${settingsPath()}). Jalankan 'sabana-code setup' di terminal interaktif.`,
      );
    }
    process.stdout.write(`\nSelamat datang di sabana-code! Home: ${sabanaHome()}\n`);
    process.stdout.write("Setup awal dulu — pilih provider LLM utama kamu.\n");
    s = await runSetupWizard();
  }
  return s;
}
