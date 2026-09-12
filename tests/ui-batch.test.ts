import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EFFORT_PRESETS, parseEffort } from "../src/effort.js";
import { formatTodoList } from "../src/todo.js";
import { SingleAgent, type AgentEvent } from "../src/agent.js";
import type { LLMProvider } from "../src/llm/provider.js";
import { setMockPlan } from "../src/llm/mock.js";
import { loadAgent, runSubAgent } from "../src/subagents.js";
import { closeDb } from "../src/db.js";

describe("effort presets", () => {
  it("low < medium < high budgets", () => {
    assert.ok(EFFORT_PRESETS.low.maxTokens < EFFORT_PRESETS.medium.maxTokens);
    assert.ok(EFFORT_PRESETS.medium.maxTokens < EFFORT_PRESETS.high.maxTokens);
    assert.ok(EFFORT_PRESETS.low.maxSteps < EFFORT_PRESETS.medium.maxSteps);
    assert.ok(EFFORT_PRESETS.medium.maxSteps < EFFORT_PRESETS.high.maxSteps);
  });

  it("parseEffort accepts names case-insensitively", () => {
    assert.equal(parseEffort("HIGH"), "high");
    assert.equal(parseEffort(" low "), "low");
    assert.equal(parseEffort("turbo"), null);
    assert.equal(parseEffort(""), null);
  });
});

describe("formatTodoList", () => {
  it("numbered 1. 2. 3. with status icons + counter", () => {
    const out = formatTodoList([
      { id: "t1", content: "setup", status: "completed", priority: "high" },
      { id: "t2", content: "code", status: "in_progress", priority: "high" },
      { id: "t3", content: "test", status: "pending", priority: "medium" },
    ]);
    const lines = out.split("\n");
    assert.equal(lines[0], "Todos (1/3):");
    assert.ok(lines[1].startsWith("1. ●"));
    assert.ok(lines[2].startsWith("2. ◐"));
    assert.ok(lines[3].startsWith("3. ○"));
  });

  it("empty list", () => {
    assert.equal(formatTodoList([]), "(no todos yet)");
  });
});

/** Provider emitting reasoning deltas then finishing (no tools). */
function thinkingProvider(text: string): LLMProvider {
  return {
    name: "thinking-mock",
    async *generate() {
      yield { type: "reasoning_delta", text };
      yield { type: "text_delta", text: "done" };
      yield { type: "finish", stop_reason: "stop" };
    },
  };
}

describe("reasoning forwarding", () => {
  it("reasoning_delta → reasoning events + reasoning_end", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sc-think-"));
    const seen: AgentEvent[] = [];
    const agent = new SingleAgent({
      model: "mock",
      provider: "mock",
      apiKey: "mock",
      baseUrl: "",
      maxTokens: 512,
      maxSteps: 5,
      autoApprove: true,
      rpm: 0,
      providerImpl: thinkingProvider("hmm, let me think"),
      onEvent: (ev) => seen.push(ev),
    });
    const t = await agent.chatTurn("hai", ws, []);
    assert.equal(t.result.success, true);
    const reasoning = seen.filter((e) => e.type === "reasoning");
    assert.ok(reasoning.length > 0);
    assert.ok(seen.some((e) => e.type === "reasoning_end"));
  });
});

describe("runSubAgent onEvent", () => {
  it("forwards tool events to the caller", async () => {
    const home = mkdtempSync(join(tmpdir(), "sc-sub-"));
    process.env.SABANA_HOME = home;
    closeDb();
    const ws = mkdtempSync(join(tmpdir(), "sc-subws-"));
    mkdirSync(join(home, "agents"), { recursive: true });
    writeFileSync(join(home, "agents", "t.md"), "---\nname: t\ndescription: d\n---\n\nBe brief.");
    const profile = loadAgent("t");
    assert.ok(profile);
    setMockPlan([{ name: "write_file", args: { path: "s.txt", content: "x" } }]);
    const types: string[] = [];
    const r = await runSubAgent(
      profile!,
      "buat s.txt",
      ws,
      { provider: "mock", apiKey: "mock", baseUrl: "", model: "mock", maxTokens: 512, maxSteps: 5, rpm: 0 },
      (ev) => types.push(ev.type),
    );
    assert.ok(types.includes("tool_start"), `events: ${types.join(",")}`);
    assert.ok(r.files.includes("s.txt"));
  });
});
