// ─── settings.json di ~/sabana-code/ — pengganti .env ───
// Dibuat saat pertama kali dijalankan (beserta sessions/, logs/, sabana.db).
// Struktur baru: default_provider + default_model + providers { [name]: { baseUrl, apiKey, model, maxTokens } }
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

export interface ProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
}

export interface SettingsFile {
  default_provider: string;
  default_model: string;
  providers: Record<string, ProviderConfig>;
  tavily_api_key: string;
}

export function settingsPath(): string {
  return join(sabanaHome(), "settings.json");
}

export function defaultSettings(): SettingsFile {
  return {
    default_provider: "openai",
    default_model: "gpt-4o-mini",
    providers: {
      openai: {
        baseUrl: PROVIDER_PRESETS.openai.baseUrl,
        apiKey: "",
        model: PROVIDER_PRESETS.openai.model,
        maxTokens: 8192,
      },
    },
    tavily_api_key: "",
  };
}

export function loadSettings(): SettingsFile {
  ensureHome();
  const path = settingsPath();
  if (!existsSync(path)) return defaultSettings();
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    // Migrate old format: env.SABANA_PROVIDER → default_provider
    if (raw.env && typeof raw.env === "object" && !raw.default_provider) {
      return migrateOldSettings(raw as { env: Record<string, string>; providers?: Record<string, { apiKey: string; baseUrl: string }> });
    }
    const merged = defaultSettings();
    return {
      default_provider: (raw.default_provider as string) || merged.default_provider,
      default_model: (raw.default_model as string) || merged.default_model,
      providers: { ...merged.providers, ...(raw.providers as Record<string, ProviderConfig> || {}) },
      tavily_api_key: (raw.tavily_api_key as string) || "",
    };
  } catch {
    return defaultSettings();
  }
}

/** Migrate old format: { env: { SABANA_PROVIDER, SABANA_BASE_URL, SABANA_API_KEY, SABANA_MODEL, ... } }
 *  → new format: { default_provider, default_model, providers: { ... }, tavily_api_key } */
function migrateOldSettings(old: { env: Record<string, string>; providers?: Record<string, { apiKey: string; baseUrl: string }> }): SettingsFile {
  const env = old.env;
  const provider = (env.SABANA_PROVIDER || "openai").toLowerCase();
  const preset = PROVIDER_PRESETS[provider];
  const s = defaultSettings();
  s.default_provider = provider;
  s.default_model = env.SABANA_MODEL || preset?.model || "";
  s.providers[provider] = {
    baseUrl: env.SABANA_BASE_URL || preset?.baseUrl || "",
    apiKey: env.SABANA_API_KEY || "",
    model: env.SABANA_MODEL || preset?.model || "",
    maxTokens: parseInt(env.SABANA_MAX_TOKEN || "8192", 10) || 8192,
  };
  // Migrate old providers extra
  if (old.providers) {
    for (const [k, v] of Object.entries(old.providers)) {
      if (k !== provider && v.apiKey) {
        const p = PROVIDER_PRESETS[k];
        s.providers[k] = {
          baseUrl: v.baseUrl || p?.baseUrl || "",
          apiKey: v.apiKey,
          model: p?.model || "",
          maxTokens: 8192,
        };
      }
    }
  }
  s.tavily_api_key = env.TAVILY_API_KEY || "";
  saveSettings(s);
  return s;
}

export function saveSettings(s: SettingsFile): void {
  ensureHome();
  writeFileSync(settingsPath(), JSON.stringify(s, null, 2) + "\n");
}

/** Get active provider config (from settings). */
export function getActiveProviderConfig(): ProviderConfig | null {
  const s = loadSettings();
  return s.providers[s.default_provider] || null;
}

/** Get config for a specific provider. */
export function getProviderConfig(name: string): ProviderConfig | null {
  const s = loadSettings();
  return s.providers[name] || null;
}

/** Update default provider + model (ensures model belongs to provider). */
export function setDefaultProvider(provider: string, model?: string): void {
  const s = loadSettings();
  const cfg = s.providers[provider];
  if (!cfg) return;
  s.default_provider = provider;
  if (model) s.default_model = model;
  else s.default_model = cfg.model;
  saveSettings(s);
}

/** Upsert a provider config. */
export function setProviderConfig(name: string, config: ProviderConfig): void {
  const s = loadSettings();
  s.providers[name] = config;
  saveSettings(s);
}

/** Remove a provider config. Cannot remove default_provider. */
export function removeProvider(name: string): boolean {
  const s = loadSettings();
  if (name === s.default_provider) return false;
  if (!s.providers[name]) return false;
  delete s.providers[name];
  saveSettings(s);
  return true;
}

/** List all stored provider names. */
export function listStoredProviders(): string[] {
  return Object.keys(loadSettings().providers);
}

/** Salin tavily_api_key ke process.env bila belum di-set. */
export function initEnvFromSettings(): SettingsFile {
  const s = loadSettings();
  if (s.tavily_api_key && !process.env.TAVILY_API_KEY) process.env.TAVILY_API_KEY = s.tavily_api_key;
  return s;
}

/** Batas request LLM per menit (default 60; <=0 = tanpa batas). */
export function rpmFromSettings(): number {
  const raw = process.env.SABANA_RPM || "60";
  const n = parseInt(raw, 10);
  return isNaN(n) ? 60 : n;
}

/** Check if settings are complete: default_provider exists + has apiKey (or doesn't need one) + has model. */
export function isSettingsComplete(s?: SettingsFile): boolean {
  const cfg = s || loadSettings();
  const providerName = cfg.default_provider;
  const preset = PROVIDER_PRESETS[providerName];
  if (!preset) return false;
  const providerCfg = cfg.providers[providerName];
  if (!providerCfg) return false;
  if (providerName === "custom" && !providerCfg.baseUrl) return false;
  if (preset.needsKey && !providerCfg.apiKey) return false;
  if (!providerCfg.model && providerName !== "mock") return false;
  return true;
}
