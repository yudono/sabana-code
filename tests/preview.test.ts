import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPreviewForTool } from "../src/tui/preview.js";
import type { PreviewRef } from "../src/tui/App.js";

function freshWs(): string {
  const ws = mkdtempSync(join(tmpdir(), "sc-preview-"));
  writeFileSync(join(ws, "App.tsx"), "const x: number = 1;\n// halo\nexport default x;\n");
  mkdirSync(join(ws, "sub"), { recursive: true });
  return ws;
}

function ref(name: string, extra: Partial<PreviewRef> = {}): PreviewRef {
  return { name, ...extra };
}

describe("buildPreviewForTool", () => {
  it("read/write reads live from disk + line numbers + ts highlight", () => {
    const ws = freshWs();
    const pv = buildPreviewForTool(
      { name: "write_file", preview: ref("write_file", { path: "App.tsx" }), summary: "write_file App.tsx" },
      ws,
    );
    assert.equal(pv.title, "write_file App.tsx");
    assert.equal(pv.lang, "ts");
    assert.ok(pv.body.includes("1  "));
    assert.ok(pv.body.includes("const x"));
  });

  it("missing files → error message + stored output fallback", () => {
    const ws = freshWs();
    const pv = buildPreviewForTool(
      {
        name: "read_file",
        preview: ref("read_file", { path: "hilang.txt" }),
        summary: "read_file hilang.txt",
        output: "isi lama",
      },
      ws,
    );
    assert.equal(pv.lang, "plain");
    assert.ok(pv.body.includes("missing"));
    assert.ok(pv.body.includes("isi lama"));
  });

  it("workspace-escaping paths refused", () => {
    const ws = freshWs();
    const pv = buildPreviewForTool(
      { name: "read_file", preview: ref("read_file", { path: "../luar.txt" }), summary: "x" },
      ws,
    );
    assert.ok(pv.body.includes("escapes workspace"));
  });

  it("modified_file shows the stored diff", () => {
    const ws = freshWs();
    const diff = "--- a.txt\n+++ a.txt\n@@ -1,2 +1,2 @@\n-old\n+new";
    const pv = buildPreviewForTool(
      {
        name: "modified_file",
        preview: ref("modified_file", { path: "a.txt" }),
        summary: "modified_file a.txt",
        output: JSON.stringify({ path: "a.txt", edited: true, added: 1, removed: 1, diff }),
      },
      ws,
    );
    assert.equal(pv.lang, "diff");
    assert.ok(pv.body.includes("+new"));
  });

  it("modified_file without diff → clear message", () => {
    const ws = freshWs();
    const pv = buildPreviewForTool(
      { name: "modified_file", preview: ref("modified_file", { path: "a.txt" }), summary: "x" },
      ws,
    );
    assert.ok(pv.body.includes("No stored diff"));
  });

  it("delete_file shows a note", () => {
    const ws = freshWs();
    const pv = buildPreviewForTool(
      {
        name: "delete_file",
        preview: ref("delete_file", { path: "a.txt" }),
        summary: "delete_file a.txt",
        output: JSON.stringify({ path: "a.txt", deleted: true }),
      },
      ws,
    );
    assert.ok(pv.body.includes("Deleted: a.txt"));
  });

  it("shell shows command + stdout/stderr", () => {
    const ws = freshWs();
    const pv = buildPreviewForTool(
      {
        name: "shell",
        preview: ref("shell", { command: "npm test" }),
        summary: "$ npm test",
        output: JSON.stringify({ exitCode: 1, stdout: "out", stderr: "boom", durationMs: 300 }),
      },
      ws,
    );
    assert.ok(pv.title.includes("npm test"));
    assert.ok(pv.body.includes("[exit 1]"));
    assert.ok(pv.body.includes("--- stdout ---"));
    assert.ok(pv.body.includes("--- stderr ---"));
    assert.ok(pv.body.includes("boom"));
  });

  it("shell: ANSI stripped + command shown", () => {
    const ws = freshWs();
    const pv = buildPreviewForTool(
      {
        name: "shell",
        preview: ref("shell", { command: "npm test" }),
        summary: "$ npm test",
        output: JSON.stringify({ exitCode: 0, stdout: "\x1b[32mok\x1b[0m", stderr: "", durationMs: 10 }),
      },
      ws,
    );
    assert.ok(pv.body.includes("ok"));
    assert.ok(!pv.body.includes("\x1b[32m"));
  });

  it("web_fetch renders as markdown", () => {
    const ws = freshWs();
    const pv = buildPreviewForTool(
      { name: "web_fetch", preview: ref("web_fetch", { url: "https://x.test" }), summary: "fetch", output: "# Judul\nisi" },
      ws,
    );
    assert.equal(pv.lang, "md");
  });

  it("python files detected as py (not generic code)", () => {
    const ws = freshWs();
    writeFileSync(join(ws, "main.py"), "def f():\n    pass\n");
    const pv = buildPreviewForTool(
      { name: "read_file", preview: ref("read_file", { path: "main.py" }), summary: "read_file main.py" },
      ws,
    );
    assert.equal(pv.lang, "py");
  });

  it("other tools fall back to raw output", () => {
    const ws = freshWs();
    const pv = buildPreviewForTool(
      { name: "glob", preview: ref("glob", { pattern: "**/*.ts" }), summary: "glob", output: '["a.ts"]' },
      ws,
    );
    assert.ok(pv.body.includes("a.ts"));
  });
});
