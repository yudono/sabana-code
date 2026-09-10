import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatResumeHint, parseTuiArgs } from "../src/tui/launch.js";

describe("parseTuiArgs", () => {
  it("defaults: cwd, 40 steps, no prompt", () => {
    const a = parseTuiArgs([]);
    assert.equal(a.workspace, process.cwd());
    assert.equal(a.maxSteps, 40);
    assert.deepEqual(a.promptParts, []);
    assert.equal(a.resumeId, null);
    assert.equal(a.cont, false);
    assert.equal(a.help, false);
  });

  it("workspace/model/provider/steps/resume/continue flags", () => {
    const a = parseTuiArgs(["-C", "/tmp/x", "--model", "m", "--provider", "ollama", "--max-steps", "7", "--resume", "abc", "--continue"]);
    assert.equal(a.workspace, "/tmp/x");
    assert.equal(a.modelFlag, "m");
    assert.equal(a.providerFlag, "ollama");
    assert.equal(a.maxSteps, 7);
    assert.equal(a.resumeId, "abc");
    assert.equal(a.cont, true);
  });

  it("positional prompts joined", () => {
    const a = parseTuiArgs(["buatkan", "hello", "world"]);
    assert.deepEqual(a.promptParts, ["buatkan", "hello", "world"]);
  });

  it("invalid max-steps ignored, -h detected", () => {
    const a = parseTuiArgs(["--max-steps", "nol", "--help"]);
    assert.equal(a.maxSteps, 40);
    assert.equal(a.help, true);
  });

  it("-r shorthand for --resume", () => {
    const a = parseTuiArgs(["-r", "abc123"]);
    assert.equal(a.resumeId, "abc123");
  });
});

describe("formatResumeHint", () => {
  it("holds short id + -r command + workspace", () => {
    const h = formatResumeHint("abc123ef9999", "/tmp/myproj");
    assert.ok(h.includes("abc123ef"));
    assert.ok(!h.includes("abc123ef9999"));
    assert.ok(h.includes("sabana-code -r abc123ef -C /tmp/myproj"));
  });

  it("spaces in workspace get quoted", () => {
    const h = formatResumeHint("abc123ef", "/tmp/my proj");
    assert.ok(h.includes('-C "/tmp/my proj"'));
  });
});
