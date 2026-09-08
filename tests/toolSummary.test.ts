import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fmtBytes,
  fmtDuration,
  fmtSigned,
  summarizeCall,
  summarizeResult,
} from "../src/tools/summary.js";

describe("fmt helpers", () => {
  it("fmtBytes memakai satuan k/M", () => {
    assert.equal(fmtBytes(292), "292");
    assert.equal(fmtBytes(11_200), "11.2k");
    assert.equal(fmtBytes(11_000), "11k");
    assert.equal(fmtBytes(2_500_000), "2.5M");
  });

  it("fmtSigned bertanda", () => {
    assert.equal(fmtSigned(1200), "+1.2k");
    assert.equal(fmtSigned(-292), "-292");
    assert.equal(fmtSigned(0), "±0");
  });

  it("fmtDuration ms/detik", () => {
    assert.equal(fmtDuration(850), "850ms");
    assert.equal(fmtDuration(1200), "1.2s");
  });
});

describe("summarizeCall", () => {
  it("file tool hanya tampil nama + path", () => {
    assert.equal(summarizeCall("read_file", { path: "App.tsx" }), "read_file App.tsx");
    assert.equal(summarizeCall("edit_file", { path: "App.tsx" }), "edit_file App.tsx");
    assert.equal(summarizeCall("write_file", { path: "a/b.ts" }), "write_file a/b.ts");
  });

  it("read_file menyertakan rentang bila diminta", () => {
    assert.equal(
      summarizeCall("read_file", { path: "App.tsx", startLine: 10, endLine: 50 }),
      "read_file App.tsx:10-50",
    );
  });

  it("shell jadi satu baris $ ...", () => {
    assert.equal(summarizeCall("shell", { command: "npm test" }), "$ npm test");
  });

  it("tool cari ringkas", () => {
    assert.equal(summarizeCall("grep", { query: "useState" }), 'grep "useState"');
    assert.equal(summarizeCall("glob", { pattern: "**/*.ts" }), "glob **/*.ts");
    assert.equal(summarizeCall("list_directory", { path: "src" }), "list src");
    assert.equal(summarizeCall("web_search", { query: "ink fullscreen" }), 'search "ink fullscreen"');
    assert.equal(summarizeCall("web_fetch", { url: "https://x.test/a" }), "fetch https://x.test/a");
  });

  it("tidak pernah memuat isi konten", () => {
    const s = summarizeCall("write_file", { path: "a.txt", content: "RAHASIA".repeat(100) });
    assert.ok(!s.includes("RAHASIA"));
  });
});

describe("summarizeResult", () => {
  it("error dipadatkan satu baris", () => {
    const s = summarizeResult("read_file", { status: "error", output: { error: "File not found: x\nbaris2" }, durationMs: 5 });
    assert.equal(s, "File not found: x");
  });

  it("read: rentang baris, bukan isi", () => {
    const s = summarizeResult("read_file", {
      status: "success",
      output: { startLine: 1, endLine: 50, totalLines: 320, content: "ISI".repeat(500) },
      durationMs: 3,
    });
    assert.equal(s, "baris 1–50 dari 320");
    assert.ok(!s!.includes("ISI"));
  });

  it("write: +byte + jumlah baris", () => {
    assert.equal(
      summarizeResult("write_file", { status: "success", output: { bytes: 11_200, lines: 45 }, durationMs: 3 }),
      "+11.2k, 45 baris",
    );
  });

  it("edit: diff bersih bertanda", () => {
    assert.equal(
      summarizeResult("edit_file", { status: "success", output: { bytesChanged: 11_200 }, durationMs: 3 }),
      "(+11.2k)",
    );
    assert.equal(
      summarizeResult("edit_file", { status: "success", output: { bytesChanged: -292 }, durationMs: 3 }),
      "(-292)",
    );
  });

  it("shell: exit + durasi", () => {
    assert.equal(
      summarizeResult("shell", { status: "success", output: { exitCode: 0 }, durationMs: 1200 }),
      "exit 0 · 1.2s",
    );
    assert.equal(
      summarizeResult("shell", { status: "success", output: { exitCode: 1 }, durationMs: 300 }),
      "exit 1 · 300ms",
    );
  });

  it("pencarian: hitungan saja", () => {
    assert.equal(summarizeResult("grep", { status: "success", output: { count: 7 }, durationMs: 1 }), "7 cocok");
    assert.equal(summarizeResult("glob", { status: "success", output: { count: 3 }, durationMs: 1 }), "3 file");
    assert.equal(
      summarizeResult("list_directory", { status: "success", output: { entries: 12 }, durationMs: 1 }),
      "12 entri",
    );
    assert.equal(
      summarizeResult("web_search", { status: "success", output: { results: [{}, {}] }, durationMs: 1 }),
      "2 hasil",
    );
    assert.equal(
      summarizeResult("web_fetch", { status: "success", output: { length: 5200 }, durationMs: 1 }),
      "+5.2k char",
    );
  });
});
