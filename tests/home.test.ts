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
  getSettingsEnv,
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

describe("settings.json", () => {
  it("default belum lengkap (tanpa API key) → lengkap setelah diisi", () => {
    isolatedHome();
    const d = defaultSettings();
    assert.equal(d.env.SABANA_PROVIDER, "openai");
    assert.equal(isSettingsComplete(d), false);
    d.env.SABANA_API_KEY = "sk-x";
    assert.equal(isSettingsComplete(d), true);
  });

  it("save → load roundtrip (bentuk {env:{...}})", () => {
    isolatedHome();
    const s = defaultSettings();
    s.env.SABANA_API_KEY = "sk-abc";
    s.env.SABANA_MODEL = "gpt-4o";
    saveSettings(s);
    const back = loadSettings();
    assert.equal(back.env.SABANA_API_KEY, "sk-abc");
    assert.equal(back.env.SABANA_MODEL, "gpt-4o");
    assert.equal(getSettingsEnv().SABANA_PROVIDER, "openai");
  });

  it("ollama/mock lengkap tanpa key; custom butuh URL", () => {
    isolatedHome();
    const s = defaultSettings();
    s.env.SABANA_PROVIDER = "ollama";
    assert.equal(isSettingsComplete(s), true);
    s.env.SABANA_PROVIDER = "custom";
    s.env.SABANA_BASE_URL = "";
    assert.equal(isSettingsComplete(s), false);
    s.env.SABANA_BASE_URL = "https://p.test/v1";
    s.env.SABANA_API_KEY = "k";
    s.env.SABANA_MODEL = "m";
    assert.equal(isSettingsComplete(s), true);
  });
});

describe("auth resolution", () => {
  it("env asli menang atas settings", () => {
    isolatedHome();
    const s = defaultSettings();
    s.env.SABANA_API_KEY = "sk-settings";
    saveSettings(s);
    saveCredential("openai", "sk-extra");
    process.env.OPENAI_KEY = "sk-env";
    try {
      const r = resolveCredentials("openai");
      assert.equal(r.apiKey, "sk-env");
      assert.equal(r.source, "env");
    } finally {
      delete process.env.OPENAI_KEY;
    }
  });

  it("fallback ke settings (provider utama, lalu providers tambahan)", () => {
    isolatedHome();
    delete process.env.OPENAI_KEY;
    const s = defaultSettings();
    s.env.SABANA_API_KEY = "sk-main";
    saveSettings(s);
    saveCredential("google", "sk-google", "https://g.test/v1");
    const main = resolveCredentials("openai");
    assert.equal(main.apiKey, "sk-main");
    assert.equal(main.source, "global");
    const extra = resolveCredentials("google");
    assert.equal(extra.apiKey, "sk-google");
    assert.equal(extra.baseUrl, "https://g.test/v1");
    assert.equal(removeCredential("openai"), true);
    assert.equal(removeCredential("google"), true);
    assert.equal(resolveCredentials("openai").source, "none");
  });

  it("mock/ollama tak butuh key", () => {
    isolatedHome();
    assert.notEqual(resolveCredentials("mock").source, "none");
  });
});
