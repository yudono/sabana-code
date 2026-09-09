import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, listSessionMeta, upsertSessionMeta } from "../src/db.js";
import { dbPath, ensureHome, logsDir, sabanaHome, sessionsDir } from "../src/home.js";
import {
  defaultSettings,
  isSettingsComplete,
  loadSettings,
  saveSettings,
} from "../src/settings.js";
import {
  removeCredential,
  resolveCredentials,
  saveCredential,
} from "../src/auth.js";
import { createSession, saveSession } from "../src/session/store.js";

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "sc-home-"));
  process.env.SABANA_HOME = home;
  // Bersihkan sisa env dari test lain (satu proses node:test)
  for (const k of ["SABANA_API_KEY", "SABANA_BASE_URL", "SABANA_MODEL", "SABANA_PROVIDER", "OPENAI_KEY", "ANTHROPIC_KEY", "TAVILY_API_KEY"]) {
    delete process.env[k];
  }
  closeDb();
  return home;
}

describe("global home", () => {
  it("membuat struktur ~/sabana-code (sessions, logs, db)", () => {
    const home = isolatedHome();
    assert.equal(sabanaHome(), home);
    ensureHome();
    assert.ok(existsSync(sessionsDir()));
    assert.ok(existsSync(logsDir()));
    assert.ok(dbPath().endsWith("sabana.db"));
  });

  it("session id berupa UUID", () => {
    isolatedHome();
    const s = createSession("m", "mock", "/tmp");
    assert.match(s.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it("save session menulis JSON + index sqlite", () => {
    isolatedHome();
    const s = createSession("gpt-4o-mini", "openai", "/tmp/ws");
    s.messages.push({ role: "user", content: "halo bench" });
    saveSession(s);
    assert.ok(existsSync(join(sessionsDir(), `${s.id}.json`)));
    const rows = listSessionMeta();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, s.id);
    assert.equal(rows[0].cwd, "/tmp/ws");
  });
});

describe("settings.json (new multi-provider format)", () => {
  it("default belum lengkap (tanpa API key) → lengkap setelah diisi", () => {
    isolatedHome();
    const d = defaultSettings();
    assert.equal(d.default_provider, "openai");
    assert.equal(d.providers.openai.apiKey, "");
    assert.equal(isSettingsComplete(d), false);
    d.providers.openai.apiKey = "sk-x";
    assert.equal(isSettingsComplete(d), true);
  });

  it("save → load roundtrip", () => {
    isolatedHome();
    const s = defaultSettings();
    s.providers.openai.apiKey = "sk-abc";
    s.providers.openai.model = "gpt-4o";
    saveSettings(s);
    const back = loadSettings();
    assert.equal(back.providers.openai.apiKey, "sk-abc");
    assert.equal(back.providers.openai.model, "gpt-4o");
    assert.equal(back.default_provider, "openai");
  });

  it("ollama/mock lengkap tanpa key; custom butuh URL", () => {
    isolatedHome();
    const s = defaultSettings();
    s.default_provider = "ollama";
    s.providers.ollama = { baseUrl: "http://localhost:11434/v1", apiKey: "", model: "qwen2.5-coder", maxTokens: 4096 };
    assert.equal(isSettingsComplete(s), true);
    s.default_provider = "custom";
    s.providers.custom = { baseUrl: "", apiKey: "k", model: "m", maxTokens: 8192 };
    assert.equal(isSettingsComplete(s), false);
    s.providers.custom.baseUrl = "https://p.test/v1";
    assert.equal(isSettingsComplete(s), true);
  });

  it("multiple providers can coexist", () => {
    isolatedHome();
    const s = defaultSettings();
    s.providers.openai.apiKey = "sk-openai";
    s.providers.openrouter = { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or", model: "qwen/qwen-2.5-coder-32b-instruct", maxTokens: 8192 };
    s.providers.anthropic = { baseUrl: "https://api.anthropic.com", apiKey: "sk-ant", model: "claude-sonnet-4-5", maxTokens: 8192 };
    saveSettings(s);
    const back = loadSettings();
    assert.equal(Object.keys(back.providers).length, 3);
    assert.equal(back.providers.openrouter.apiKey, "sk-or");
    assert.equal(back.providers.anthropic.model, "claude-sonnet-4-5");
  });
});

describe("auth resolution", () => {
  it("env asli menang atas settings", () => {
    isolatedHome();
    const s = defaultSettings();
    s.providers.openai.apiKey = "sk-settings";
    saveSettings(s);
    process.env.OPENAI_KEY = "sk-env";
    try {
      const r = resolveCredentials("openai");
      assert.equal(r.apiKey, "sk-env");
      assert.equal(r.source, "env");
    } finally {
      delete process.env.OPENAI_KEY;
    }
  });

  it("fallback ke settings.providers[name]", () => {
    isolatedHome();
    delete process.env.OPENAI_KEY;
    const s = defaultSettings();
    s.providers.openai.apiKey = "sk-openai";
    s.providers.openrouter = { baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-or", model: "test", maxTokens: 8192 };
    saveSettings(s);
    const main = resolveCredentials("openai");
    assert.equal(main.apiKey, "sk-openai");
    assert.equal(main.source, "global");
    const extra = resolveCredentials("openrouter");
    assert.equal(extra.apiKey, "sk-or");
    assert.equal(extra.source, "global");
  });

  it("mock/ollama tak butuh key", () => {
    isolatedHome();
    assert.notEqual(resolveCredentials("mock").source, "none");
  });
});
