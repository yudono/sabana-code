import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchProviderModels,
  isChatModelId,
  resolveProvider,
} from "../src/llm/models.js";
import { PROVIDER_PRESETS, SUPPORTED_PROVIDERS } from "../src/settings.js";
import { parseCommand } from "../src/tui/commands.js";

beforeEach(() => {
  process.env.SABANA_HOME = mkdtempSync(join(tmpdir(), "sc-prov-"));
  for (const k of ["OPENAI_KEY", "SABANA_API_KEY", "GROQ_API_KEY", "CUSTOM_API_KEY", "CUSTOM_BASEURL"]) {
    delete process.env[k];
  }
});

function fakeOpenAICompat(handler: (reqUrl: string, auth: string) => { status: number; body: unknown }): Promise<{ server: Server; base: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const out = handler(req.url || "", req.headers.authorization || "");
      res.writeHead(out.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      resolve({ server, base: `http://127.0.0.1:${port}/v1` });
    });
  });
}

describe("provider presets", () => {
  it("groq/together/openrouter/perplexity registered + need keys", () => {
    for (const p of ["groq", "together", "openrouter", "perplexity"]) {
      assert.ok(SUPPORTED_PROVIDERS.includes(p), `${p} hilang`);
      assert.ok(PROVIDER_PRESETS[p].baseUrl.startsWith("https://"), `${p} base`);
      assert.equal(PROVIDER_PRESETS[p].needsKey, true);
      assert.equal(resolveProvider(p).needsKey, true);
    }
  });

  it("resolveProvider groq/custom uses defaults when env is empty", () => {
    assert.equal(resolveProvider("groq").baseUrl, "https://api.groq.com/openai/v1");
    assert.equal(resolveProvider("groq").apiKey, "");
    assert.equal(resolveProvider("openrouter").baseUrl, "https://openrouter.ai/api/v1");
  });
});

describe("isChatModelId", () => {
  it("filters out non-chat", () => {
    assert.equal(isChatModelId("gpt-4o"), true);
    assert.equal(isChatModelId("llama-3.3-70b-versatile"), true);
    assert.equal(isChatModelId("whisper-1"), false);
    assert.equal(isChatModelId("tts-1-hd"), false);
    assert.equal(isChatModelId("text-embedding-3-small"), false);
    assert.equal(isChatModelId("dall-e-3"), false);
  });
});

describe("fetchProviderModels", () => {
  it("live from OpenAI-compatible endpoint + sends Bearer", async () => {
    let seenAuth = "";
    const { server, base } = await fakeOpenAICompat((url, auth) => {
      seenAuth = auth;
      assert.ok(url.endsWith("/models"));
      return { status: 200, body: { data: [{ id: "llama-3.3-70b-versatile" }, { id: "whisper-large-v3" }, { id: "mixtral-8x7b" }] } };
    });
    try {
      process.env.CUSTOM_BASEURL = base;
      process.env.CUSTOM_API_KEY = "k-test";
      const r = await fetchProviderModels("custom");
      assert.equal(r.ok, true);
      assert.equal(r.source, "live");
      assert.deepEqual(r.models, ["llama-3.3-70b-versatile", "mixtral-8x7b", "whisper-large-v3"]);
      assert.equal(seenAuth, "Bearer k-test");
      assert.deepEqual(r.models.filter(isChatModelId), ["llama-3.3-70b-versatile", "mixtral-8x7b"]);
    } finally {
      server.close();
    }
  });

  it("401 → ok:false + message", async () => {
    const { server, base } = await fakeOpenAICompat(() => ({ status: 401, body: { error: "bad key" } }));
    try {
      process.env.CUSTOM_BASEURL = base;
      process.env.CUSTOM_API_KEY = "salah";
      const r = await fetchProviderModels("custom");
      assert.equal(r.ok, false);
      assert.match(r.error || "", /401/);
    } finally {
      server.close();
    }
  });

  it("no key → fast ok:false", async () => {
    const r = await fetchProviderModels("groq");
    assert.equal(r.ok, false);
    assert.match(r.error || "", /API key/);
  });

  it("anthropic catalog fallback (no network)", async () => {
    const r = await fetchProviderModels("anthropic");
    assert.equal(r.ok, true);
    assert.equal(r.source, "catalog");
    assert.ok(r.models.length > 0);
  });
});

describe("providers/models commands parse", () => {
  it("parse /providers use groq + /models filter", () => {
    assert.deepEqual(parseCommand("/providers use groq"), { name: "providers", args: ["use", "groq"] });
    assert.deepEqual(parseCommand("/models llama"), { name: "models", args: ["llama"] });
    assert.deepEqual(parseCommand("/models 3"), { name: "models", args: ["3"] });
    assert.deepEqual(parseCommand("/compact"), { name: "compact", args: [] });
  });
});
