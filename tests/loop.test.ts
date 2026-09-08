import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { LoopDetector } from "../src/utils/loop.js";

describe("loop detector", () => {
  it("mendeteksi tool sama + argumen sama 3x beruntun", () => {
    const d = new LoopDetector();
    const args = { path: "a.txt" };
    assert.equal(d.record("read_file", args).detected, false);
    assert.equal(d.record("read_file", args).detected, false);
    assert.equal(d.record("read_file", args).detected, true);
  });

  it("tidak false-positive untuk panggilan berbeda", () => {
    const d = new LoopDetector();
    for (let i = 0; i < 5; i++) {
      assert.equal(d.record("read_file", { path: `f${i}.txt` }).detected, false);
    }
  });

  it("mendeteksi jendela tanpa write setelah ada write", () => {
    const d = new LoopDetector();
    d.record("write_file", { path: "a.txt", content: "x" });
    let last = { detected: false };
    for (let i = 0; i < 12; i++) {
      last = d.record("read_file", { path: `f${i}.txt` });
    }
    assert.equal(last.detected, true);
  });

  it("resetProgress memberi ruang segar", () => {
    const d = new LoopDetector();
    d.record("write_file", { path: "a.txt", content: "x" });
    for (let i = 0; i < 12; i++) d.record("read_file", { path: `f${i}.txt` });
    d.resetProgress();
    assert.equal(d.record("read_file", { path: "z.txt" }).detected, false);
  });

  it("mendeteksi error sama berulang", () => {
    const d = new LoopDetector();
    assert.equal(d.recordError("boom 123").detected, false);
    assert.equal(d.recordError("boom 456").detected, false);
    const third = d.recordError("boom 789");
    assert.equal(third.detected, true);
  });
});
