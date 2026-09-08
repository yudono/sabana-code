import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseTuiArgs } from "../src/tui/launch.js";

describe("parseTuiArgs", () => {
  it("default: cwd, 40 step, tanpa prompt", () => {
    const a = parseTuiArgs([]);
    assert.equal(a.workspace, process.cwd());
    assert.equal(a.maxSteps, 40);
    assert.deepEqual(a.promptParts, []);
    assert.equal(a.resumeId, null);
    assert.equal(a.cont, false);
    assert.equal(a.help, false);
  });

  it("flag workspace/model/provider/steps/resume/continue", () => {
    const a = parseTuiArgs(["-C", "/tmp/x", "--model", "m", "--provider", "ollama", "--max-steps", "7", "--resume", "abc", "--continue"]);
    assert.equal(a.workspace, "/tmp/x");
    assert.equal(a.modelFlag, "m");
    assert.equal(a.providerFlag, "ollama");
    assert.equal(a.maxSteps, 7);
    assert.equal(a.resumeId, "abc");
    assert.equal(a.cont, true);
  });

  it("prompt posisional digabung", () => {
    const a = parseTuiArgs(["buatkan", "hello", "world"]);
    assert.deepEqual(a.promptParts, ["buatkan", "hello", "world"]);
  });

  it("max-steps invalid diabaikan, -h terdeteksi", () => {
    const a = parseTuiArgs(["--max-steps", "nol", "--help"]);
    assert.equal(a.maxSteps, 40);
    assert.equal(a.help, true);
  });
});
