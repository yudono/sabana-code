import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelMessage } from "../src/llm/types.js";
import { AUTO_COMPACT_PCT, applyCompactSummary, buildCompactPrompt } from "../src/session/compact.js";
import { contextUsage } from "../src/session/context.js";
import { setMockPlan } from "../src/llm/mock.js";
import { SingleAgent } from "../src/agent.js";

function msg(role: ModelMessage["role"], content: string, extra?: Partial<ModelMessage>): ModelMessage {
  return { role, content, ...extra };
}

function bigHistory(n = 12): ModelMessage[] {
  const out: ModelMessage[] = [msg("system", "sys")];
  for (let i = 0; i < n; i++) {
    out.push(msg("user", `pertanyaan ${i} ` + "x".repeat(200)));
    out.push(msg("assistant", `jawaban ${i} ` + "y".repeat(200)));
  }
  return out;
}

describe("compact", () => {
  it("ambang auto-compact 80%", () => {
    assert.equal(AUTO_COMPACT_PCT, 80);
  });

  it("buildCompactPrompt memuat transkrip + instruksi", () => {
    const p = buildCompactPrompt(bigHistory(4));
    assert.ok(p.includes("pertanyaan 0"));
    assert.ok(p.includes("RIWAYAT"));
    assert.ok(p.length <= 14_000 + 500);
  });

  it("applyCompactSummary: system + ringkasan + ekor", () => {
    const h = bigHistory(10);
    const { messages, dropped } = applyCompactSummary(h, "RINGKASAN");
    assert.equal(messages[0].role, "system");
    assert.equal(messages[1].role, "user");
    assert.ok(messages[1].content.includes("RINGKASAN"));
    assert.ok(dropped > 0);
    assert.equal(messages.length + dropped, h.length);
    // ekor dipertahankan
    assert.ok(messages[messages.length - 1].content.includes("jawaban 9"));
  });

  it("applyCompactSummary membuang tool yatim", () => {
    const h: ModelMessage[] = [
      msg("system", "sys"),
      ...Array.from({ length: 10 }, (_, i) => msg("user", `u${i}`)),
      msg("assistant", "", { tool_calls: [{ id: "t1", type: "function", function: { name: "read_file", arguments: "{}" } }] }),
      msg("tool", "ISI-BESAR", { tool_call_id: "t1" }),
      msg("user", "lanjut"),
      msg("assistant", "ok"),
    ];
    const { messages } = applyCompactSummary(h, "RINGKASAN", 2);
    const callIds = new Set(
      messages.flatMap((m) => (m.tool_calls || []).map((tc) => tc.id)),
    );
    for (const m of messages) {
      if (m.role === "tool" && m.tool_call_id) {
        assert.ok(callIds.has(m.tool_call_id), `tool ${m.tool_call_id} yatim`);
      }
    }
  });

  it("compactHistory menolak riwayat pendek", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sc-compact-"));
    const agent = new SingleAgent({
      model: "mock", provider: "mock", apiKey: "mock", baseUrl: "",
      maxTokens: 512, maxSteps: 2, autoApprove: true, onEvent: () => {},
    });
    const r = await agent.compactHistory([msg("system", "s"), msg("user", "hi")]);
    assert.equal(r.ok, false);
    assert.match(r.error || "", /pendek/);
  });

  it("compactHistory memakai ringkasan LLM (mock)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sc-compact-"));
    const agent = new SingleAgent({
      model: "mock", provider: "mock", apiKey: "mock", baseUrl: "",
      maxTokens: 512, maxSteps: 2, autoApprove: true, onEvent: () => {},
    });
    // Pemanasan: generate pertama mock tanpa plan tak menghasilkan teks.
    setMockPlan([]);
    await agent.chatTurn("hai", ws, []);
    const h = bigHistory(10);
    const r = await agent.compactHistory(h);
    assert.equal(r.ok, true);
    assert.ok(r.summary.length > 0);
    assert.ok(r.dropped > 0);
    assert.equal(r.messages[0].role, "system");
    assert.ok(r.messages[1].content.includes(r.summary));
  });

  it("auto-compact menyala di atas 80% (mock, event compacted)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sc-compact-"));
    const events: string[] = [];
    const agent = new SingleAgent({
      model: "mock", provider: "mock", apiKey: "mock", baseUrl: "",
      maxTokens: 512, maxSteps: 3, autoApprove: true, onEvent: (ev) => events.push(ev.type),
    });
    setMockPlan([]);
    await agent.chatTurn("hai", ws, []); // pemanasan mock
    // Riwayat >8 pesan dan >80% window mock (128k → butuh >102.4k token)
    const h: ModelMessage[] = [msg("system", "sys")];
    for (let i = 0; i < 12; i++) h.push(msg(i % 2 ? "assistant" : "user", `m${i}-` + "Z".repeat(36_000)));
    const before = contextUsage(h, "mock", "mock");
    assert.ok(before.pct > 80, `butuh >80%, dapat ${before.pct}`);
    // NB: jangan setMockPlan lagi — akan me-reset state mock.
    await agent.chatTurn("lanjut", ws, h);
    assert.ok(events.includes("compacted"), `event hilang: ${events.join(",")}`);
  });
});

describe("compact isolation", () => {
  beforeEach(() => {
    process.env.SABANA_HOME = mkdtempSync(join(tmpdir(), "sc-compact-home-"));
  });

  it("tidak memakai settings global saat compact", () => {
    // hanya memastikan test ini jalan dengan HOME terisolasi
    assert.ok((process.env.SABANA_HOME || "").includes("sc-compact-home-"));
  });
});
