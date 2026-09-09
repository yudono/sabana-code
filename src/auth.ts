// ─── Kredensial: resolve per provider dari settings.json + env ───
// Settings.json sekarang punya { default_provider, default_model, providers: { [name]: { apiKey, baseUrl, ... } } }
// Tiap provider punya config sendiri, tidak saling tumpuk.
import { loadSettings, saveSettings } from "./settings.js";
import { resolveProvider } from "./llm/models.js";

export interface ResolvedCreds {
  apiKey: string;
  baseUrl: string;
  source: "env" | "global" | "none";
}

export function resolveCredentials(provider: string): ResolvedCreds {
  // 1. Env asli (tanpa settings) → sumber "env"
  const raw = resolveProvider(provider, { settings: false });
  if (!raw.needsKey) return { apiKey: raw.apiKey, baseUrl: raw.baseUrl, source: "env" };
  if (raw.apiKey) return { apiKey: raw.apiKey, baseUrl: raw.baseUrl, source: "env" };
  // 2. settings.json: cek providers[provider]
  const s = loadSettings();
  const providerCfg = s.providers[provider];
  if (providerCfg?.apiKey) {
    return { apiKey: providerCfg.apiKey, baseUrl: providerCfg.baseUrl || raw.baseUrl, source: "global" };
  }
  return { apiKey: "", baseUrl: raw.baseUrl, source: "none" };
}

/** Simpan key provider ke settings.json (global). */
export function saveCredential(provider: string, apiKey: string, baseUrl = ""): void {
  const s = loadSettings();
  const existing = s.providers[provider];
  const preset = { baseUrl: "", model: "", maxTokens: 8192 };
  // Resolve default baseUrl from resolveProvider
  const resolved = resolveProvider(provider);
  s.providers[provider] = {
    baseUrl: baseUrl || existing?.baseUrl || resolved.baseUrl,
    apiKey,
    model: existing?.model || preset.model,
    maxTokens: existing?.maxTokens || preset.maxTokens,
  };
  saveSettings(s);
}

export function removeCredential(provider: string): boolean {
  const s = loadSettings();
  // Cannot remove default_provider
  if (provider === s.default_provider) return false;
  if (!s.providers[provider]) return false;
  delete s.providers[provider];
  saveSettings(s);
  return true;
}

export function credentialSummary(): Array<{ provider: string; source: string }> {
  const s = loadSettings();
  const providers = Object.keys(s.providers).filter((p) => p !== "mock");
  return providers.map((p) => ({
    provider: p,
    source: s.providers[p].apiKey ? "global" : "none",
  }));
}

export function listStoredProviders(): string[] {
  return Object.keys(loadSettings().providers);
}
