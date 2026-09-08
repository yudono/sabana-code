// ─── settings.json di ~/sabana-code/ — pengganti .env ───
// Dibuat saat pertama kali dijalankan (beserta sessions/, logs/, sabana.db).
// Bentuk file persis seperti yang diminta user:
//   { "env": { "SABANA_PROVIDER": "openai", "SABANA_BASE_URL": "...", ... } }
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureHome, sabanaHome } from "./home.js";

export interface ProviderPreset {
  baseUrl: string;
  model: string;
  needsKey: boolean;
  hint: string;
}

export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    needsKey: true,
    hint: "OpenAI API (platform.openai.com)",
  },
  anthropic: {
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-4-5",
    needsKey: true,
    hint: "Anthropic API (console.anthropic.com)",
  },
  google: {
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    model: "gemini-2.5-flash",
    needsKey: true,
    hint: "Gemini via endpoint OpenAI-compatible (aistudio.google.com)",
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    model: "llama-3.3-70b-versatile",
    needsKey: true,
    hint: "Groq ultra-cepat (console.groq.com)",
  },
  together: {
    baseUrl: "https://api.together.xyz/v1",
    model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    needsKey: true,
    hint: "Together AI, banyak model open (api.together.ai)",
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "qwen/qwen-2.5-coder-32b-instruct",
    needsKey: true,
    hint: "OpenRouter, ratusan model (openrouter.ai)",
  },
  perplexity: {
    baseUrl: "https://api.perplexity.ai",
    model: "sonar-pro",
    needsKey: true,
    hint: "Perplexity + pencarian web (perplexity.ai)",
  },
  ollama: {
    baseUrl: "http://localhost:11434/v1",
    model: "qwen2.5-coder",
    needsKey: false,
    hint: "Lokal, gratis (butuh 'ollama serve' + 'ollama pull <model>')",
  },
  custom: {
    baseUrl: "",
    model: "",
    needsKey: true,
    hint: "URL kustom yang OpenAI-compatible (proxy / provider lain)",
  },
  mock: {
    baseUrl: "",
    model: "mock",
    needsKey: false,
    hint: "Deterministik tanpa LLM (benchmark / coba-coba)",
  },
};

export const SUPPORTED_PROVIDERS = Object.keys(PROVIDER_PRESETS);

export interface ProviderCreds {
  apiKey: string;
  baseUrl: string;
}

export interface SettingsFile {
  env: Record<string, string>;
  /** Kredensial provider tambahan selain provider utama. */
  providers?: Record<string, ProviderCreds>;
}

export function settingsPath(): string {
  return join(sabanaHome(), "settings.json");
}

export function defaultSettings(): SettingsFile {
  const p = PROVIDER_PRESETS.openai;
  return {
    env: {
      SABANA_PROVIDER: "openai",
      SABANA_BASE_URL: p.baseUrl,
      SABANA_API_KEY: "",
      SABANA_MODEL: p.model,
      SABANA_MAX_TOKEN: "8192",
      SABANA_RPM: "60",
      TAVILY_API_KEY: "",
    },
  };
}

export function loadSettings(): SettingsFile {
  ensureHome();
  const path = settingsPath();
  if (!existsSync(path)) return defaultSettings();
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Partial<SettingsFile>;
    const merged = defaultSettings();
    return {
      env: { ...merged.env, ...(raw.env || {}) },
      ...(raw.providers ? { providers: raw.providers } : {}),
    };
  } catch {
    return defaultSettings();
  }
}

export function saveSettings(s: SettingsFile): void {
  ensureHome();
  writeFileSync(settingsPath(), JSON.stringify(s, null, 2) + "\n");
}

export function getSettingsEnv(): Record<string, string> {
  return loadSettings().env || {};
}

/** Salin settings ke process.env bila belum di-set (env asli selalu menang). */
export function initEnvFromSettings(): SettingsFile {
  const s = loadSettings();
  for (const [k, v] of Object.entries(s.env || {})) {
    if (v && !process.env[k]) process.env[k] = v;
  }
  return s;
}

/** Batas request LLM per menit (default 60; <=0 = tanpa batas). */
export function rpmFromSettings(): number {
  const raw = process.env.SABANA_RPM || getSettingsEnv().SABANA_RPM || "60";
  const n = parseInt(raw, 10);
  return isNaN(n) ? 60 : n;
}

/** Lengkap bila provider jelas dan (tak butuh key / key sudah ada). */
export function isSettingsComplete(s?: SettingsFile): boolean {
  const cfg = s || loadSettings();
  const provider = (cfg.env.SABANA_PROVIDER || "").toLowerCase();
  const preset = PROVIDER_PRESETS[provider];
  if (!preset) return false;
  if (provider === "custom" && !cfg.env.SABANA_BASE_URL) return false;
  if (preset.needsKey && !cfg.env.SABANA_API_KEY) return false;
  if (!cfg.env.SABANA_MODEL && provider !== "mock") return false;
  return true;
}
