import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSession,
  lastSession,
  listSessions,
  loadSession,
  saveSession,
} from "../src/session/store.js";
import { contextUsage, ensureFits } from "../src/session/context.js";
import type { ModelMessage } from "../src/llm/types.js";

function isolatedHome(): void {
  process.env.SABANA_HOME = mkdtempSync(join(tmpdir(), "sc-sess-"));
}

describe("session store", () => {
  it("save → list → load (id prefix supported)", () => {
    isolatedHome();
    const s = createSession("gpt-4o-mini", "openai", "/tmp/ws");
    s.messages.push({ role: "user", content: "halo" });
    saveSession(s);
    const list = listSessions();
    assert.equal(list.length, 1);
    assert.equal(list[0].turns, 1);
    assert.ok(loadSession(s.id));
    assert.ok(loadSession(s.id.slice(0, 6)));
    assert.equal(loadSession("tidak-ada"), null);
  });

  it("auto title from first message + lastSession", () => {
    isolatedHome();
    const s = createSession("m", "mock", "/tmp");
    s.messages.push({ role: "user", content: "buatkan x" });
    saveSession(s);
    assert.equal(lastSession()?.title, "buatkan x");
  });

  it("approvals: new sessions empty, saved, and reloaded", () => {
    isolatedHome();
    const s = createSession("m", "mock", "/tmp");
    assert.deepEqual(s.approvals, { allowAll: [], denied: [] });
    s.approvals = { allowAll: ["shell:npm"], denied: ["shell:rm"] };
    saveSession(s);
    const back = loadSession(s.id)!;
    assert.deepEqual(back.approvals, { allowAll: ["shell:npm"], denied: ["shell:rm"] });
  });

  it("approvals: old sessions without the field backfill empty", async () => {
    isolatedHome();
    const s = createSession("m", "mock", "/tmp");
    saveSession(s);
    const { readFileSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const file = join(process.env.SABANA_HOME!, "sessions", `${s.id}.json`);
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    delete raw.approvals;
    writeFileSync(file, JSON.stringify(raw));
    assert.deepEqual(loadSession(s.id)!.approvals, { allowAll: [], denied: [] });
  });
});

describe("context guard", () => {
  const msg = (content: string): ModelMessage => ({ role: "user", content });

  it("counts usage against the model window", () => {
    const u = contextUsage([msg("a".repeat(400))], "gpt-4o-mini", "openai");
    assert.equal(u.tokens, 100);
    assert.equal(u.window, 128_000);
  });

  it("trim keeps system + first user and shrinks context", () => {
    const big = "x".repeat(40_000); // ~10k token per pesan
    const messages: ModelMessage[] = [
      { role: "system", content: "sys" },
      msg("pertama"),
      msg(big),
      msg(big),
      msg(big),
      msg(big),
      msg(big),
      msg(big),
    ];
    const before = messages.reduce((n, m) => n + Math.ceil((m.content || "").length / 4), 0);
    const r = ensureFits(messages, "qwen2.5-coder", "ollama", 8_192);
    assert.ok(r.trimmed > 0);
    assert.equal(r.messages[0].role, "system");
    assert.equal(r.messages[1].content, "pertama");
    assert.ok(r.usage.tokens < before);
  });

  it("trim drops orphan tool results", () => {
    const big = "y".repeat(20_000);
    const messages: ModelMessage[] = [
      { role: "system", content: "sys" },
      msg("pertama"),
      { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "read_file", arguments: "{}" } }] },
      { role: "tool", content: big, tool_call_id: "1" },
      { role: "assistant", content: "", tool_calls: [{ id: "2", type: "function", function: { name: "grep", arguments: "{}" } }] },
      { role: "tool", content: big, tool_call_id: "2" },
      msg("lanjut " + big),
    ];
    const r = ensureFits(messages, "qwen2.5-coder", "ollama", 30_000);
    assert.ok(r.trimmed > 0);
    // Setiap pesan tool yang tersisa wajib punya induk tool_call
    const callIds = new Set(
      r.messages.flatMap((m) => (m.tool_calls || []).map((tc) => tc.id)),
    );
    for (const m of r.messages) {
      if (m.role === "tool" && m.tool_call_id) {
        assert.ok(callIds.has(m.tool_call_id), `tool ${m.tool_call_id} yatim`);
      }
    }
  });

  it("no trim when it still fits", () => {
    const r = ensureFits([msg("hi")], "gpt-4o-mini", "openai");
    assert.equal(r.trimmed, 0);
  });
});
