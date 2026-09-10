// ─── Katalog model + context window ───
// One session can keep going until the active model's context window limit.
// Each model has different limits → the TUI shows usage + auto-trim.
// Now reads config from settings.providers[provider] (not env.SABANA_*).
import { loadSettings } from "../settings.js";

export interface ModelInfo {
  id: string;
  provider: string;
  contextWindow: number;
  maxOutput: number;
  description: string;
}

const CATALOG: ModelInfo[] = [
  // OpenAI-compatible
  { id: "gpt-4o-mini", provider: "openai", contextWindow: 128_000, maxOutput: 16_384, description: "Cheap & fast, default" },
  { id: "gpt-4o", provider: "openai", contextWindow: 128_000, maxOutput: 16_384, description: "Versatile" },
  { id: "gpt-4.1", provider: "openai", contextWindow: 1_000_000, maxOutput: 32_768, description: "1M-token context" },
  { id: "gpt-4.1-mini", provider: "openai", contextWindow: 1_000_000, maxOutput: 32_768, description: "1M context, cheap" },
  { id: "o4-mini", provider: "openai", contextWindow: 200_000, maxOutput: 100_000, description: "Reasoning" },
  // Anthropic
  { id: "claude-sonnet-4-5", provider: "anthropic", contextWindow: 200_000, maxOutput: 8_192, description: "Strong coding" },
  { id: "claude-haiku-4-5", provider: "anthropic", contextWindow: 200_000, maxOutput: 8_192, description: "Fast & cheap" },
  { id: "claude-opus-4-1", provider: "anthropic", contextWindow: 200_000, maxOutput: 8_192, description: "Smartest" },
  // Google Gemini (endpoint OpenAI-compatible)
  { id: "gemini-2.5-flash", provider: "google", contextWindow: 1_000_000, maxOutput: 32_768, description: "Fast, 1M context" },
  { id: "gemini-2.5-pro", provider: "google", contextWindow: 1_000_000, maxOutput: 32_768, description: "Smartest" },
  // Groq
  { id: "llama-3.3-70b-versatile", provider: "groq", contextWindow: 128_000, maxOutput: 8_192, description: "Fast & strong" },
  { id: "qwen-qwq-32b", provider: "groq", contextWindow: 128_000, maxOutput: 8_192, description: "Reasoning" },
  // Together AI
  { id: "meta-llama/Llama-3.3-70B-Instruct-Turbo", provider: "together", contextWindow: 128_000, maxOutput: 8_192, description: "Fast Llama" },
  { id: "Qwen/Qwen2.5-Coder-32B-Instruct", provider: "together", contextWindow: 32_768, maxOutput: 8_192, description: "Coding" },
  // OpenRouter
  { id: "qwen/qwen-2.5-coder-32b-instruct", provider: "openrouter", contextWindow: 32_768, maxOutput: 8_192, description: "Cheap coding" },
  { id: "anthropic/claude-sonnet-4", provider: "openrouter", contextWindow: 200_000, maxOutput: 8_192, description: "Strong coding" },
  // Perplexity
  { id: "sonar-pro", provider: "perplexity", contextWindow: 200_000, maxOutput: 8_000, description: "Research + web" },
  { id: "sonar", provider: "perplexity", contextWindow: 127_000, maxOutput: 8_000, description: "Light + web" },
  // Ollama / local
  { id: "qwen2.5-coder", provider: "ollama", contextWindow: 32_768, maxOutput: 4_096, description: "Local coding" },
  { id: "llama3.1", provider: "ollama", contextWindow: 128_000, maxOutput: 4_096, description: "Versatile, local" },
  { id: "deepseek-r1", provider: "ollama", contextWindow: 128_000, maxOutput: 8_192, description: "Local reasoning" },
  // Mock (benchmark / no key)
  { id: "mock", provider: "mock", contextWindow: 128_000, maxOutput: 4_096, description: "Deterministic, no LLM" },
];

const PROVIDER_DEFAULT_WINDOW: Record<string, number> = {
  openai: 128_000,
  anthropic: 200_000,
  google: 1_000_000,
  groq: 128_000,
  together: 128_000,
  openrouter: 128_000,
  perplexity: 127_000,
  ollama: 32_768,
  custom: 128_000,
  mock: 128_000,
};

export function listModels(provider?: string): ModelInfo[] {
  return provider ? CATALOG.filter((m) => m.provider === provider) : [...CATALOG];
}

export function findModel(id: string, provider?: string): ModelInfo | undefined {
  const lower = id.toLowerCase();
  return CATALOG.find((m) => {
    if (provider && m.provider !== provider) return false;
    return m.id.toLowerCase() === lower || `${m.provider}/${m.id}`.toLowerCase() === lower;
  });
}

/** Context window for a model+provider pair (provider-default fallback when unknown). */
export function getContextWindow(model: string, provider: string): number {
  return (
    findModel(model, provider)?.contextWindow ??
    PROVIDER_DEFAULT_WINDOW[provider] ??
    32_768
  );
}

export function getMaxOutput(model: string, provider: string): number {
  return findModel(model, provider)?.maxOutput ?? 4_096;
}

/** Estimasi kasar token (~4 char/token, pola sabana-dev). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface ProviderCreds {
  baseUrl: string;
  apiKey: string;
  needsKey: boolean;
}

/**
 * Resolve kredensial + baseUrl per provider.
 * Prioritas: 1) env asli, 2) settings.providers[name], 3) preset defaults.
 * settings:false option → raw env only (to detect "env" vs "global" sources).
 */
export function resolveProvider(provider: string, opts?: { settings?: boolean }): ProviderCreds {
  const useSettings = opts?.settings !== false;
  const pick = (...names: string[]): string => {
    for (const n of names) if (process.env[n]) return process.env[n];
    return "";
  };

  // 1. Env asli (always wins)
  if (provider === "anthropic") {
    const key = pick("ANTHROPIC_KEY", "SABANA_API_KEY", "OPENAI_KEY");
    if (key) return { baseUrl: pick("ANTHROPIC_BASEURL", "SABANA_BASE_URL") || "https://api.anthropic.com", apiKey: key, needsKey: true };
  }
  if (provider === "google") {
    const key = pick("GOOGLE_API_KEY", "GEMINI_API_KEY", "SABANA_API_KEY");
    if (key) return { baseUrl: pick("GOOGLE_BASEURL", "SABANA_BASE_URL") || "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: key, needsKey: true };
  }
  const COMPAT_ENV: Record<string, { base: string; keys: string[] }> = {
    groq: { base: "https://api.groq.com/openai/v1", keys: ["GROQ_API_KEY"] },
    together: { base: "https://api.together.xyz/v1", keys: ["TOGETHER_API_KEY"] },
    openrouter: { base: "https://openrouter.ai/api/v1", keys: ["OPENROUTER_API_KEY"] },
    perplexity: { base: "https://api.perplexity.ai", keys: ["PERPLEXITY_API_KEY", "PPLX_API_KEY"] },
  };
  if (provider in COMPAT_ENV) {
    const d = COMPAT_ENV[provider];
    const key = pick(...d.keys, "SABANA_API_KEY");
    if (key) return { baseUrl: pick(`${provider.toUpperCase()}_BASEURL`, "SABANA_BASE_URL") || d.base, apiKey: key, needsKey: true };
  }
  if (provider === "ollama") {
    const key = pick("OPENAI_KEY", "SABANA_API_KEY") || "ollama";
    return { baseUrl: pick("OLLAMA_BASEURL", "SABANA_BASE_URL") || "http://localhost:11434/v1", apiKey: key, needsKey: false };
  }
  if (provider === "mock") {
    return { baseUrl: "", apiKey: "mock", needsKey: false };
  }
  if (provider === "custom") {
    const key = pick("CUSTOM_API_KEY", "SABANA_API_KEY");
    if (key) return { baseUrl: pick("CUSTOM_BASEURL", "SABANA_BASE_URL"), apiKey: key, needsKey: true };
  }
  // Default (openai)
  const openaiKey = pick("OPENAI_KEY", "SABANA_API_KEY");
  if (openaiKey) return { baseUrl: pick("OPENAI_BASEURL", "SABANA_BASE_URL") || "https://api.openai.com/v1", apiKey: openaiKey, needsKey: true };

  // 2. settings.providers[name] (when settings:true)
  if (useSettings) {
    const s = loadSettings();
    const cfg = s.providers[provider];
    if (cfg?.apiKey) {
      return { baseUrl: cfg.baseUrl || PROVIDER_DEFAULTS[provider] || "", apiKey: cfg.apiKey, needsKey: true };
    }
  }

  // 3. Fallback: no key, use preset defaults
  const preset = PROVIDER_DEFAULTS_OBJ[provider];
  return { baseUrl: preset?.baseUrl || "", apiKey: "", needsKey: true };
}

const PROVIDER_DEFAULTS: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com/v1beta/openai",
  groq: "https://api.groq.com/openai/v1",
  together: "https://api.together.xyz/v1",
  openrouter: "https://openrouter.ai/api/v1",
  perplexity: "https://api.perplexity.ai",
  ollama: "http://localhost:11434/v1",
  custom: "",
  mock: "",
};

const PROVIDER_DEFAULTS_OBJ: Record<string, { baseUrl: string }> = {
  openai: { baseUrl: "https://api.openai.com/v1" },
  anthropic: { baseUrl: "https://api.anthropic.com" },
  google: { baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai" },
  groq: { baseUrl: "https://api.groq.com/openai/v1" },
  together: { baseUrl: "https://api.together.xyz/v1" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1" },
  perplexity: { baseUrl: "https://api.perplexity.ai" },
  ollama: { baseUrl: "http://localhost:11434/v1" },
  custom: { baseUrl: "" },
  mock: { baseUrl: "" },
};

/** "Connect provider": quick connection test before session use. */
export async function testProviderConnection(provider: string): Promise<{ ok: boolean; detail: string }> {
  const { baseUrl, apiKey, needsKey } = resolveProvider(provider);
  if (needsKey && !apiKey) {
    return { ok: false, detail: "API key not set" };
  }
  try {
    if (provider === "ollama") {
      const res = await fetch(`${baseUrl.replace(/\/v1$/, "")}/api/tags`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return { ok: false, detail: `ollama: HTTP ${res.status} — make sure 'ollama serve' jalan` };
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      const names = (data.models || []).map((m) => m.name).join(", ") || "(no models yet, use 'ollama pull ...')";
      return { ok: true, detail: `ollama connected. Local models: ${names.slice(0, 200)}` };
    }
    if (provider === "anthropic") {
      return { ok: true, detail: "API key ditemukan. Koneksi real diuji saat turn pertama." };
    }
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { ok: false, detail: `HTTP ${res.status}: ${t.slice(0, 160)}` };
    }
    return { ok: true, detail: "OpenAI-compatible provider connected." };
  } catch (e) {
    return { ok: false, detail: `Unreachable: ${(e as Error).message}` };
  }
}

/** Filter non-chat IDs (audio/image/embedding/moderation) from /v1/models lists. */
export function isChatModelId(id: string): boolean {
  return !/whisper|tts|dall-e|moderation|embedding|audio|image|realtime|transcri|omni-moderation/i.test(id);
}

export interface ProviderModelList {
  ok: boolean;
  models: string[];
  source: "live" | "catalog" | "none";
  error?: string;
}

/**
 * Fetch the model list from the provider endpoint.
 * OpenAI-compatible: GET {baseUrl}/models. Ollama: GET /api/tags. Anthropic: tak ada list publik.
 */
export async function fetchProviderModels(
  provider: string,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<ProviderModelList> {
  const { baseUrl, apiKey, needsKey } = resolveProvider(provider);
  if (provider === "anthropic") {
    const fallback = listModels("anthropic").map((m) => m.id);
    return { ok: true, models: fallback, source: "catalog", error: "Anthropic has no public list — built-in catalog." };
  }
  if (needsKey && !apiKey) {
    return { ok: false, models: [], source: "none", error: "API key not set." };
  }
  const timeoutMs = opts?.timeoutMs ?? 10_000;
  try {
    if (provider === "mock") {
      return { ok: true, models: ["mock"], source: "catalog" };
    }
    if (provider === "ollama") {
      const res = await fetch(`${baseUrl.replace(/\/v1$/, "")}/api/tags`, {
        signal: opts?.signal ?? AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return { ok: false, models: [], source: "none", error: `ollama: HTTP ${res.status}` };
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      return { ok: true, models: (data.models || []).map((m) => m.name), source: "live" };
    }
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: opts?.signal ?? AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { ok: false, models: [], source: "none", error: `HTTP ${res.status}: ${t.slice(0, 160)}` };
    }
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const models = (data.data || []).map((m) => m.id).filter(Boolean).sort();
    return { ok: true, models, source: "live" };
  } catch (e) {
    return { ok: false, models: [], source: "none", error: `Unreachable: ${(e as Error).message}` };
  }
}
