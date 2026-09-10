import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { itemRows, sliceItemTail, type ChatItem } from "../src/tui/App.js";

const user = (text: string): ChatItem => ({ kind: "user", text });
const assistant = (text: string): ChatItem => ({ kind: "assistant", text });

describe("viewport itemRows", () => {
  it("short lines = content + chrome box (border 2 + margin 1)", () => {
    assert.equal(itemRows(user("halo"), 80), 4);
  });

  it("long lines wrap to box width (cols-6, prefix ❯ = 3 cells)", () => {
    // lebar konten = 80-6 = 74; prefix "❯ " = 3 sel
    assert.equal(itemRows(user("a".repeat(71)), 80), 4);
    assert.equal(itemRows(user("a".repeat(72)), 80), 5);
    assert.equal(itemRows(user("a".repeat(142)), 80), 5);
    assert.equal(itemRows(user("a".repeat(146)), 80), 6);
  });

  it("multilines count per row + chrome box", () => {
    assert.equal(itemRows(assistant("l1\nl2"), 80), 5); // 2 baris + 3 chrome
    assert.equal(itemRows(user("l1\nl2"), 80), 5);
  });

  it("wide (CJK) chars count 2 cells", () => {
    // "あ"*35 = 70 sel + prefix 3 = 73 → 1 baris → 4; *36 = 75 → 2 baris → 5
    assert.equal(itemRows(user("あ".repeat(35)), 80), 4);
    assert.equal(itemRows(user("あ".repeat(36)), 80), 5);
  });

  it("prefix ❯ is counted (safe bias: symbols = 2 cells)", () => {
    // "❯ "(2+1) + 70 char = 73 sel → 1 baris → 4; +1 char → 2 baris → 5
    assert.equal(itemRows(user("b".repeat(70)), 80), 4);
    assert.equal(itemRows(user("b".repeat(71)), 80), 4);
    assert.equal(itemRows(user("b".repeat(72)), 80), 5);
  });

  it("tools always 1 content row + chrome for short summaries", () => {
    const t: ChatItem = { kind: "tool", id: "1", summary: "read_file App.tsx", status: "ok", detail: "baris 1–50 dari 320" };
    assert.equal(itemRows(t, 80), 4);
  });

  it("sliceItemTail: fitting items returned whole", () => {
    const a: ChatItem = { kind: "assistant", text: "l1\nl2\nl3" };
    assert.deepEqual(sliceItemTail(a, 10, 80), a);
  });

  it("sliceItemTail: giant items tail-sliced + marker", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `baris-${i}`);
    const a: ChatItem = { kind: "assistant", text: lines.join("\n") };
    const cut = sliceItemTail(a, 10, 80);
    assert.ok(cut.text.startsWith("… ("));
    assert.ok(cut.text.includes("baris-49"));
    assert.ok(!cut.text.includes("baris-0\n"));
    assert.ok(itemRows(cut, 80) <= 10);
  });

  it("sliceItemTail: ignores tool kind, slices giant users", () => {
    const t: ChatItem = { kind: "tool", id: "1", summary: "x".repeat(500), status: "ok" };
    assert.deepEqual(sliceItemTail(t, 5, 80), t);
    const u: ChatItem = { kind: "user", text: Array.from({ length: 50 }, (_, i) => `b-${i}`).join("\n") };
    const cut = sliceItemTail(u, 10, 80);
    assert.ok(cut.text.includes("b-49"));
    assert.ok(itemRows(cut, 80) <= 10);
  });
});
