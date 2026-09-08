// ─── Katalog model + context window ───
// Satu session bisa terus jalan sampai batas context window model yang dipakai.
// Tiap model punya batas berbeda → TUI menampilkan pemakaian + auto-trim.
import { getSettingsEnv } from "../settings.js";

export interface ModelInfo {
  id: string;
  provider: string;
  contextWindow: number;
  maxOutput: number;
  description: string;
}

const CATALOG: ModelInfo[] = [
  // OpenAI-compatible
  { id: "gpt-4o-mini", provider: "openai", contextWindow: 128_000, maxOutput: 16_384, description: "Murah & cepat, default" },
  { id: "gpt-4o", provider: "openai", contextWindow: 128_000, maxOutput: 16_384, description: "Serbaguna" },
  { id: "gpt-4.1", provider: "openai", contextWindow: 1_000_000, maxOutput: 32_768, description: "Konteks 1M token" },
  { id: "gpt-4.1-mini", provider: "openai", contextWindow: 1_000_000, maxOutput: 32_768, description: "Konteks 1M, hemat" },
  { id: "o4-mini", provider: "openai", contextWindow: 200_000, maxOutput: 100_000, description: "Reasoning" },
  // Anthropic
  { id: "claude-sonnet-4-5", provider: "anthropic", contextWindow: 200_000, maxOutput: 8_192, description: "Coding kuat" },
  { id: "claude-haiku-4-5", provider: "anthropic", contextWindow: 200_000, maxOutput: 8_192, description: "Cepat & hemat" },
  { id: "claude-opus-4-1", provider: "anthropic", contextWindow: 200_000, maxOutput: 8_192, description: "Paling pintar" },
  // Google Gemini (endpoint OpenAI-compatible)
  { id: "gemini-2.5-flash", provider: "google", contextWindow: 1_000_000, maxOutput: 32_768, description: "Cepat, konteks 1M" },
  { id: "gemini-2.5-pro", provider: "google", contextWindow: 1_000_000, maxOutput: 32_768, description: "Paling pintar" },
  // Ollama / lokal
  { id: "qwen2.5-coder", provider: "ollama", contextWindow: 32_768, maxOutput: 4_096, description: "Coding lokal" },
  { id: "llama3.1", provider: "ollama", contextWindow: 128_000, maxOutput: 4_096, description: "Serbaguna lokal" },
  { id: "deepseek-r1", provider: "ollama", contextWindow: 128_000, maxOutput: 8_192, description: "Reasoning lokal" },
  // Mock (benchmark / tanpa key)
  { id: "mock", provider: "mock", contextWindow: 128_000, maxOutput: 4_096, description: "Deterministik, tanpa LLM" },
];

const PROVIDER_DEFAULT_WINDOW: Record<string, number> = {
  openai: 128_000,
  anthropic: 200_000,
  google: 1_000_000,
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

/** Context window untuk pasangan model+provider (fallback default provider bila tak dikenal). */
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

/** Kredensial + baseURL per provider: env asli dulu, lalu settings.json (bila provider-nya cocok).
 *  Opsi settings:false → hanya env asli (dipakai deteksi sumber "env" vs "global"). */
export function resolveProvider(provider: string, opts?: { settings?: boolean }): ProviderCreds {
  const useSettings = opts?.settings !== false;
  const pick = (...names: string[]): string => {
    for (const n of names) if (process.env[n]) return process.env[n];
    if (!useSettings) return "";
    const s = getSettingsEnv();
    if ((s.SABANA_PROVIDER || "").toLowerCase() === provider) {
      for (const n of names) if (s[n]) return s[n];
    }
    return "";
  };
  if (provider === "anthropic") {
    return {
      baseUrl: pick("ANTHROPIC_BASEURL", "SABANA_BASE_URL") || "https://api.anthropic.com",
      apiKey: pick("ANTHROPIC_KEY", "SABANA_API_KEY", "OPENAI_KEY"),
      needsKey: true,
    };
  }
  if (provider === "google") {
    return {
      baseUrl:
        pick("GOOGLE_BASEURL", "SABANA_BASE_URL") ||
        "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: pick("GOOGLE_API_KEY", "GEMINI_API_KEY", "SABANA_API_KEY"),
      needsKey: true,
    };
  }
  if (provider === "ollama") {
    return {
      baseUrl: pick("OLLAMA_BASEURL", "SABANA_BASE_URL") || "http://localhost:11434/v1",
      apiKey: pick("OPENAI_KEY", "SABANA_API_KEY") || "ollama",
      needsKey: false,
    };
  }
  if (provider === "mock") {
    return { baseUrl: "", apiKey: "mock", needsKey: false };
  }
  if (provider === "custom") {
    return {
      baseUrl: pick("CUSTOM_BASEURL", "SABANA_BASE_URL"),
      apiKey: pick("CUSTOM_API_KEY", "SABANA_API_KEY"),
      needsKey: true,
    };
  }
  return {
    baseUrl: pick("OPENAI_BASEURL", "SABANA_BASE_URL") || "https://api.openai.com/v1",
    apiKey: pick("OPENAI_KEY", "SABANA_API_KEY"),
    needsKey: true,
  };
}

/** "Connect provider": uji cepat koneksi sebelum dipakai session. */
export async function testProviderConnection(provider: string): Promise<{ ok: boolean; detail: string }> {
  const { baseUrl, apiKey, needsKey } = resolveProvider(provider);
  if (needsKey && !apiKey) {
    return { ok: false, detail: "API key belum di-set di .env" };
  }
  try {
    if (provider === "ollama") {
      const res = await fetch(`${baseUrl.replace(/\/v1$/, "")}/api/tags`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return { ok: false, detail: `ollama: HTTP ${res.status} — pastikan 'ollama serve' jalan` };
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      const names = (data.models || []).map((m) => m.name).join(", ") || "(belum ada model, pakai 'ollama pull ...')";
      return { ok: true, detail: `ollama terhubung. Model lokal: ${names.slice(0, 200)}` };
    }
    if (provider === "anthropic") {
      // Anthropic tak punya endpoint list publik via API key konsumen — anggap ok bila key ada.
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
    return { ok: true, detail: "Provider OpenAI-compatible terhubung." };
  } catch (e) {
    return { ok: false, detail: `Tidak terjangkau: ${(e as Error).message}` };
  }
}
