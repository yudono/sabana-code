import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { helpText, parseCommand } from "../src/tui/commands.js";
import { setMockPlan } from "../src/llm/mock.js";
import { SingleAgent } from "../src/agent.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("slash commands", () => {
  it("parse /perintah + argumen", () => {
    assert.deepEqual(parseCommand("/resume abc123"), { name: "resume", args: ["abc123"] });
    assert.deepEqual(parseCommand("/MODEL gpt-4o"), { name: "model", args: ["gpt-4o"] });
    assert.deepEqual(parseCommand("  /quit  "), { name: "quit", args: [] });
  });

  it("bukan perintah → null", () => {
    assert.equal(parseCommand("halo dunia"), null);
    assert.equal(parseCommand("/"), null);
  });

  it("help memuat semua perintah", () => {
    const h = helpText();
    for (const c of ["help", "new", "sessions", "projects", "resume", "model", "provider", "login", "logout", "agents", "agent", "context", "tools", "clear", "quit"]) {
      assert.ok(h.includes(`/${c}`), `help tidak memuat /${c}`);
    }
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

  it("chatTurn mengembalikan history yang tumbuh antar turn", async () => {
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

  it("setModelProvider ganti model mid-session", async () => {
    const ws = mkdtempSync(join(tmpdir(), "sc-multiturn-"));
    const agent = mockAgent();
    agent.setModelProvider("gpt-4o", "mock", "mock", "");
    setMockPlan([]);
    const t = await agent.chatTurn("hai", ws, []);
    assert.equal(t.result.success, true);
  });
});
