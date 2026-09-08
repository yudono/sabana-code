import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { itemRows, sliceItemTail, type ChatItem } from "../src/tui/App.js";

const user = (text: string): ChatItem => ({ kind: "user", text });
const assistant = (text: string): ChatItem => ({ kind: "assistant", text });

describe("viewport itemRows", () => {
  it("baris pendek = 1 baris", () => {
    assert.equal(itemRows(user("halo"), 80), 1);
  });

  it("baris panjang wrap sesuai lebar (termasuk prefix ❯ = 3 sel)", () => {
    // lebar teks = cols-4 = 76; prefix "❯ " = 3 sel → sisa 73
    assert.equal(itemRows(user("a".repeat(73)), 80), 1);
    assert.equal(itemRows(user("a".repeat(74)), 80), 2);
    assert.equal(itemRows(user("a".repeat(146)), 80), 2);
    assert.equal(itemRows(user("a".repeat(150)), 80), 3); // 153 sel / 76 → 3
  });

  it("multiline dihitung per baris + margin assistant", () => {
    assert.equal(itemRows(assistant("l1\nl2"), 80), 3); // 2 baris + 1 margin
    assert.equal(itemRows(user("l1\nl2"), 80), 2); // tanpa margin
  });

  it("karakter lebar (CJK) dihitung 2 sel", () => {
    // "あ"*36 = 72 sel + prefix 3 = 75 → 1 baris; *37 = 77 → 2 baris
    assert.equal(itemRows(user("あ".repeat(36)), 80), 1);
    assert.equal(itemRows(user("あ".repeat(37)), 80), 2);
  });

  it("prefix ❯ ikut dihitung (bias aman: simbol = 2 sel)", () => {
    // "❯ "(2+1) + 73 char = 76 sel → 1 baris; +1 char → 2 baris
    assert.equal(itemRows(user("b".repeat(73)), 80), 1);
    assert.equal(itemRows(user("b".repeat(74)), 80), 2);
  });

  it("tool selalu 1 baris untuk ringkasan pendek", () => {
    const t: ChatItem = { kind: "tool", id: "1", summary: "read_file App.tsx", status: "ok", detail: "baris 1–50 dari 320" };
    assert.equal(itemRows(t, 80), 1);
  });

  it("sliceItemTail: item muat dikembalikan utuh", () => {
    const a: ChatItem = { kind: "assistant", text: "l1\nl2\nl3" };
    assert.deepEqual(sliceItemTail(a, 10, 80), a);
  });

  it("sliceItemTail: item raksasa dipotong ekor + penanda", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `baris-${i}`);
    const a: ChatItem = { kind: "assistant", text: lines.join("\n") };
    const cut = sliceItemTail(a, 10, 80);
    assert.ok(cut.text.startsWith("… ("));
    assert.ok(cut.text.includes("baris-49"));
    assert.ok(!cut.text.includes("baris-0\n"));
    assert.ok(itemRows(cut, 80) <= 10);
  });

  it("sliceItemTail: abaikan kind tool, potong user raksasa", () => {
    const t: ChatItem = { kind: "tool", id: "1", summary: "x".repeat(500), status: "ok" };
    assert.deepEqual(sliceItemTail(t, 5, 80), t);
    const u: ChatItem = { kind: "user", text: Array.from({ length: 50 }, (_, i) => `b-${i}`).join("\n") };
    const cut = sliceItemTail(u, 10, 80);
    assert.ok(cut.text.includes("b-49"));
    assert.ok(itemRows(cut, 80) <= 10);
  });
});
