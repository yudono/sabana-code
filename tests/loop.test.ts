import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LoopDetector } from "../src/utils/loop.js";

describe("loop detector", () => {
  it("detects same tool + same args 3x in a row", () => {
    const d = new LoopDetector();
    const args = { path: "a.txt" };
    assert.equal(d.record("read_file", args).detected, false);
    assert.equal(d.record("read_file", args).detected, false);
    assert.equal(d.record("read_file", args).detected, true);
  });

  it("no false positives for different calls", () => {
    const d = new LoopDetector();
    for (let i = 0; i < 5; i++) {
      assert.equal(d.record("read_file", { path: `f${i}.txt` }).detected, false);
    }
  });

  it("detects write-less windows after a write", () => {
    const d = new LoopDetector();
    d.record("write_file", { path: "a.txt", content: "x" });
    let last = { detected: false };
    for (let i = 0; i < 12; i++) {
      last = d.record("read_file", { path: `f${i}.txt` });
    }
    assert.equal(last.detected, true);
  });

  it("resetProgress gives fresh room", () => {
    const d = new LoopDetector();
    d.record("write_file", { path: "a.txt", content: "x" });
    for (let i = 0; i < 12; i++) d.record("read_file", { path: `f${i}.txt` });
    d.resetProgress();
    assert.equal(d.record("read_file", { path: "z.txt" }).detected, false);
  });

  it("detects repeating identical errors", () => {
    const d = new LoopDetector();
    assert.equal(d.recordError("boom 123").detected, false);
    assert.equal(d.recordError("boom 456").detected, false);
    const third = d.recordError("boom 789");
    assert.equal(third.detected, true);
  });
});
