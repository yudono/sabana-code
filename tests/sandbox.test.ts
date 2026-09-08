import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safePath } from "../src/tools/sandbox.js";

describe("sandbox safePath", () => {
  const ws = mkdtempSync(join(tmpdir(), "sc-sandbox-"));

  it("mengizinkan path relatif di dalam workspace", () => {
    const p = safePath(ws, "src/a.txt");
    assert.ok(p && p.startsWith(ws));
  });

  it("memblokir traversal ../ keluar workspace", () => {
    assert.equal(safePath(ws, "../evil.txt"), null);
    assert.equal(safePath(ws, "a/../../evil.txt"), null);
  });

  it("memblokir absolute path di luar workspace", () => {
    assert.equal(safePath(ws, "/etc/passwd"), null);
  });

  it("mengizinkan '.' sebagai workspace root", () => {
    assert.equal(safePath(ws, "."), ws);
  });

  it("mengupas prefix sandbox/ karena workspace IS root", () => {
    const p = safePath(ws, "sandbox/src/a.txt");
    assert.ok(p && p.startsWith(ws) && !p.includes("sandbox/sandbox"));
  });
});
