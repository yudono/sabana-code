import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { helpText, parseCommand, suggestCommands } from "../src/tui/commands.js";
import { historyStep, previewKeyAction } from "../src/tui/App.js";
import { setMockPlan } from "../src/llm/mock.js";
import { SingleAgent } from "../src/agent.js";
import type { LLMProvider } from "../src/llm/provider.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("slash commands", () => {
  it("parses /command + args", () => {
    assert.deepEqual(parseCommand("/resume abc123"), { name: "resume", args: ["abc123"] });
    assert.deepEqual(parseCommand("/MODEL gpt-4o"), { name: "model", args: ["gpt-4o"] });
    assert.deepEqual(parseCommand("  /quit  "), { name: "quit", args: [] });
  });

  it("non-command → null", () => {
    assert.equal(parseCommand("halo dunia"), null);
    assert.equal(parseCommand("/"), null);
  });

  it("help lists all commands", () => {
    const h = helpText();
    for (const c of ["help", "new", "sessions", "projects", "resume", "models", "providers", "compact", "effort", "login", "logout", "agents", "agent", "skills", "skill", "todo", "mcp", "checkpoint", "checkpoints", "rewind", "context", "tools", "clear", "quit"]) {
      assert.ok(h.includes(`/${c}`), `help tidak memuat /${c}`);
    }
    for (const c of ["model ", "provider "]) {
      assert.ok(!h.includes(`/${c}`), `help masih memuat perintah lama /${c}`);
    }
  });
});

describe("slash autocomplete", () => {
  it("bare '/' prefix → all commands", () => {
    const all = suggestCommands("/");
    assert.ok(all.includes("/help") && all.includes("/models") && all.includes("/quit"));
  });

  it("filter by prefix", () => {
    assert.deepEqual(suggestCommands("/mod"), ["/models"]);
    assert.ok(suggestCommands("/m").includes("/models"));
    assert.ok(suggestCommands("/m").includes("/mcp"));
    assert.deepEqual(suggestCommands("/xyz"), []);
  });

  it("non-slash / complete command+args → empty", () => {
    assert.deepEqual(suggestCommands("halo"), []);
    assert.deepEqual(suggestCommands("/models 2"), []);
    assert.deepEqual(suggestCommands("/quit "), []);
  });
});

describe("prompt history navigation", () => {
  it("↑ from draft → newest; ↓ back to draft", () => {
    assert.equal(historyStep(null, -1, 3), 2);
    assert.equal(historyStep(null, 1, 3), null);
    assert.equal(historyStep(2, -1, 3), 1);
    assert.equal(historyStep(0, -1, 3), 0);
    assert.equal(historyStep(1, 1, 3), 2);
    assert.equal(historyStep(2, 1, 3), null);
  });

  it("empty history → null", () => {
    assert.equal(historyStep(null, -1, 0), null);
  });
});

describe("preview key handling (regression: Esc must always close)", () => {
  it("Esc → close", () => {
    assert.equal(previewKeyAction("", { escape: true }), "close");
  });

  it("Ctrl+C → close", () => {
    assert.equal(previewKeyAction("c", { ctrl: true }), "close");
  });

  it("arrows/PgUp/PgDn → scroll", () => {
    assert.equal(previewKeyAction("", { upArrow: true }), "up");
    assert.equal(previewKeyAction("", { downArrow: true }), "down");
    assert.equal(previewKeyAction("", { pageUp: true }), "pageup");
    assert.equal(previewKeyAction("", { pageDown: true }), "pagedown");
  });

  it("other keys → null (ignored)", () => {
    assert.equal(previewKeyAction("a", {}), null);
    assert.equal(previewKeyAction("", { return: true }), null);
  });
});

describe("agent multi-turn (mock)", () => {
  function mockAgent(): SingleAgent {
    return new SingleAgent({
      model: "mock",
      provider: "mock",
      apiKey: "mock",
      baseUrl: "",
      maxTokens: 512,
      maxSteps: 5,
      autoApprove: true,
      onEvent: () => {},
    });
  }

  it("chatTurn returns history growing across turns", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sc-multiturn-"));
    const agent = mockAgent();
    setMockPlan([{ name: "write_file", args: { path: "a.txt", content: "hi" } }]);
    const t1 = await agent.chatTurn("buat a.txt", ws, []);
    assert.equal(t1.result.success, true);
    assert.deepEqual(t1.result.filesModified, ["a.txt"]);
    const n1 = t1.messages.length;
    assert.ok(n1 > 2);

    setMockPlan([{ name: "write_file", args: { path: "b.txt", content: "yo" } }]);
    const t2 = await agent.chatTurn("buat b.txt", ws, t1.messages);
    assert.equal(t2.result.success, true);
    assert.ok(t2.messages.length > n1);
    // file turn 1 tetap terlacak (sesi berkesinambungan)
    assert.ok(t2.result.filesModified.includes("a.txt"));
    assert.ok(t2.result.filesModified.includes("b.txt"));
  });

  it("setModelProvider switches model mid-session", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sc-multiturn-"));
    const agent = mockAgent();
    agent.setModelProvider("gpt-4o", "mock", "mock", "");
    setMockPlan([]);
    const t = await agent.chatTurn("hai", ws, []);
    assert.equal(t.result.success, true);
  });

  it("hung providers fail fast via llmTimeoutMs (no endless hang)", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sc-timeout-"));
    const hanging = {
      name: "hang",
      async *generate(request: { signal?: AbortSignal }): AsyncIterable<never> {
        await new Promise<void>((_, reject) => {
          if (request.signal?.aborted) {
            reject(request.signal.reason);
            return;
          }
          request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
        });
        throw new Error("unreachable");
      },
    };
    const agent = new SingleAgent({
      model: "mock",
      provider: "mock",
      apiKey: "mock",
      baseUrl: "",
      maxTokens: 512,
      maxSteps: 5,
      autoApprove: true,
      llmTimeoutMs: 150,
      providerImpl: hanging as unknown as LLMProvider,
      onEvent: () => {},
    });
    const t0 = Date.now();
    const t = await agent.chatTurn("hai", ws, []);
    assert.ok(Date.now() - t0 < 20_000, "took too long — timeout did not fire");
    assert.equal(t.result.success, false);
    assert.match(t.result.finalText, /timed out/i);
  });
});
