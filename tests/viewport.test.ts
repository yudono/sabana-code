import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { itemRowList, sliceRowWindow, wrapText, type ChatItem, type ChatRow } from "../src/tui/App.js";

const user = (text: string, id = "u1"): ChatItem => ({ kind: "user", id, text });
const assistant = (text: string): ChatItem => ({ kind: "assistant", text });
const rows = (it: ChatItem, cols = 80): ChatRow[] => itemRowList(it, cols);
const texts = (rs: ChatRow[]): string[] => rs.map((r) => r.segs.map((s) => s.text).join(""));

describe("wrapText", () => {
  it("short lines stay whole, empties kept", () => {
    assert.deepEqual(wrapText("halo", 76), ["halo"]);
    assert.deepEqual(wrapText("l1\n\nl2", 76), ["l1", "", "l2"]);
  });

  it("greedy char-wrap at exact width", () => {
    assert.deepEqual(wrapText("a".repeat(76), 76), ["a".repeat(76)]);
    assert.deepEqual(wrapText("a".repeat(77), 76), ["a".repeat(76), "a"]);
  });

  it("wide (CJK) chars count 2 cells", () => {
    assert.deepEqual(wrapText("あ".repeat(38), 76), ["あ".repeat(38)]);
    assert.deepEqual(wrapText("あ".repeat(39), 76), ["あ".repeat(38), "あ"]);
  });
});

describe("itemRowList (flat rows + gap)", () => {
  it("user rows carry a green ❯ prefix on the first row", () => {
    const rs = rows(user("halo"));
    assert.equal(rs.length, 2); // 1 content + 1 gap
    assert.equal(rs[0].segs[0].text, "❯ ");
    assert.equal(rs[0].segs[0].color, "green");
    assert.equal(rs[0].segs[1].text, "halo");
    assert.deepEqual(rs[1].segs, [{ text: "" }]);
    assert.equal(rs[0].toolId, undefined);
  });

  it("long user text wraps with prefix counted (cols-4 width)", () => {
    // content width = 80-4 = 76; "❯ "(3) + 73 a's = 76 → fits
    assert.equal(rows(user("a".repeat(73))).length, 2);
    // 74 a's → 2 content rows + gap
    const rs = rows(user("a".repeat(74)));
    assert.equal(rs.length, 3);
    assert.equal(rs[1].segs[0].text, "a");
  });

  it("assistant rows are plain + gap", () => {
    const rs = rows(assistant("l1\nl2"));
    assert.deepEqual(texts(rs), ["l1", "l2", ""]);
    assert.ok(rs.every((r) => r.toolId === undefined));
  });

  it("tool rows carry dim style + toolId for clicks", () => {
    const t: ChatItem = { kind: "tool", id: "t1", name: "read_file", preview: { name: "read_file" }, summary: "read_file App.tsx", status: "ok" };
    const rs = rows(t);
    assert.equal(rs.length, 2);
    assert.equal(rs[0].toolId, "t1");
    assert.equal(rs[0].segs[0].dim, true);
    assert.ok(rs[0].segs[0].text.startsWith("✓"));
  });

  it("error tool rows are red, running rows yellow", () => {
    const e: ChatItem = { kind: "tool", id: "e", name: "shell", preview: { name: "shell" }, summary: "$ rm x", status: "error" };
    assert.equal(rows(e)[0].segs[0].color, "red");
    const r: ChatItem = { kind: "tool", id: "r", name: "shell", preview: { name: "shell" }, summary: "$ npm test", status: "running" };
    assert.equal(rows(r)[0].segs[0].color, "yellow");
  });

  it("info rows keep their tone", () => {
    const rs = rows({ kind: "info", tone: "red", text: "boom" });
    assert.equal(rs[0].segs[0].color, "red");
    const dim = rows({ kind: "info", tone: "dim", text: "hi" });
    assert.equal(dim[0].segs[0].dim, true);
  });

  it("giant items flatten fully (window slices them, no page break)", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `row-${i}`);
    const rs = rows(assistant(lines.join("\n")));
    assert.equal(rs.length, 51); // 50 content + 1 gap
    assert.equal(rs[0].segs[0].text, "row-0");
    assert.equal(rs[49].segs[0].text, "row-49");
  });
});

describe("sliceRowWindow (smooth per-row scroll)", () => {
  it("scroll 0 → tail pinned to bottom", () => {
    assert.deepEqual(sliceRowWindow(10, 6, 0), { start: 4, scroll: 0 });
  });

  it("every scroll step moves exactly 1 row (no jumps)", () => {
    const starts = [0, 1, 2, 3, 4].map((s) => sliceRowWindow(10, 6, s).start);
    assert.deepEqual(starts, [4, 3, 2, 1, 0]);
  });

  it("partial edge rows included (sliced, not dropped)", () => {
    // total 10, avail 6, scroll 3 → rows[1..6] (top partial kept)
    assert.deepEqual(sliceRowWindow(10, 6, 3), { start: 1, scroll: 3 });
  });

  it("scroll clamps to the maximum", () => {
    assert.deepEqual(sliceRowWindow(6, 6, 999), { start: 0, scroll: 0 });
    assert.deepEqual(sliceRowWindow(0, 10, 0), { start: 0, scroll: 0 });
  });

  it("empty/short feeds show everything", () => {
    assert.deepEqual(sliceRowWindow(3, 10, 0), { start: 0, scroll: 0 });
  });
});
