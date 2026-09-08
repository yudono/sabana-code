// ─── Kredensial: env asli menang, lalu ~/sabana-code/settings.json ───
// settings.json menyimpan provider utama di `env` + provider tambahan di
// `providers`, sehingga agent bisa jalan dari direktori mana pun tanpa .env.
import {
  SUPPORTED_PROVIDERS,
  loadSettings,
  saveSettings,
} from "./settings.js";
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
  // 2. settings.json: provider utama, lalu providers tambahan → "global"
  const withSettings = resolveProvider(provider);
  const s = loadSettings();
  const main = (s.env.SABANA_PROVIDER || "").toLowerCase() === provider && s.env.SABANA_API_KEY;
  const extra = s.providers?.[provider];
  if (main) {
    return { apiKey: s.env.SABANA_API_KEY, baseUrl: withSettings.baseUrl, source: "global" };
  }
  if (extra?.apiKey) {
    return { apiKey: extra.apiKey, baseUrl: extra.baseUrl || withSettings.baseUrl, source: "global" };
  }
  return { apiKey: "", baseUrl: withSettings.baseUrl, source: "none" };
}

/** Simpan key provider ke settings.json (global). */
export function saveCredential(provider: string, apiKey: string, baseUrl = ""): void {
  const s = loadSettings();
  const main = (s.env.SABANA_PROVIDER || "").toLowerCase() === provider;
  if (main) {
    s.env.SABANA_API_KEY = apiKey;
    if (baseUrl) s.env.SABANA_BASE_URL = baseUrl;
  }
  s.providers = { ...(s.providers || {}), [provider]: { apiKey, baseUrl } };
  saveSettings(s);
}

export function removeCredential(provider: string): boolean {
  const s = loadSettings();
  let removed = false;
  if (s.providers?.[provider]) {
    delete s.providers[provider];
    removed = true;
  }
  if ((s.env.SABANA_PROVIDER || "").toLowerCase() === provider && s.env.SABANA_API_KEY) {
    s.env.SABANA_API_KEY = "";
    removed = true;
  }
  if (removed) saveSettings(s);
  return removed;
}

export function credentialSummary(): Array<{ provider: string; source: string }> {
  return SUPPORTED_PROVIDERS.filter((p) => p !== "mock").map((p) => ({
    provider: p,
    source: resolveCredentials(p).source,
  }));
}

export function listStoredProviders(): string[] {
  return Object.keys(loadSettings().providers || {});
}
