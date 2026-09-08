import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  editFileHandler,
  globHandler,
  grepHandler,
  listDirectoryHandler,
  readFileHandler,
  writeFileHandler,
} from "../src/tools/filesystem.js";

function freshWs(): string {
  return mkdtempSync(join(tmpdir(), "sc-fs-"));
}

describe("filesystem tools", () => {
  it("write lalu read mengembalikan konten bernomor baris", async () => {
    const ws = freshWs();
    const w = (await writeFileHandler(ws)({ path: "a.txt", content: "hello\nworld\n" })) as {
      written: boolean;
    };
    assert.equal(w.written, true);
    const r = (await readFileHandler(ws)({ path: "a.txt" })) as {
      content: string;
      totalLines: number;
    };
    assert.equal(r.totalLines, 3);
    assert.ok(r.content.includes("1: hello"));
    assert.ok(r.content.includes("2: world"));
  });

  it("read mendukung rentang baris", async () => {
    const ws = freshWs();
    await writeFileHandler(ws)({ path: "b.txt", content: "l1\nl2\nl3\nl4" });
    const r = (await readFileHandler(ws)({ path: "b.txt", startLine: 2, endLine: 3 })) as {
      content: string;
    };
    assert.ok(r.content.includes("2: l2"));
    assert.ok(r.content.includes("3: l3"));
    assert.ok(!r.content.includes("l4"));
  });

  it("read file hilang mengembalikan error", async () => {
    const ws = freshWs();
    const r = (await readFileHandler(ws)({ path: "nope.txt" })) as { error: string };
    assert.ok(r.error.includes("not found"));
  });

  it("write di luar workspace ditolak", async () => {
    const ws = freshWs();
    const r = (await writeFileHandler(ws)({ path: "../evil.txt", content: "x" })) as {
      error: string;
      denied: boolean;
    };
    assert.equal(r.denied, true);
  });

  it("edit sukses mengubah konten", async () => {
    const ws = freshWs();
    await writeFileHandler(ws)({ path: "c.txt", content: "foo bar" });
    const r = (await editFileHandler(ws)({ path: "c.txt", search: "bar", replace: "baz" })) as {
      edited: boolean;
    };
    assert.equal(r.edited, true);
    const back = (await readFileHandler(ws)({ path: "c.txt" })) as { content: string };
    assert.ok(back.content.includes("foo baz"));
  });

  it("edit gagal bila search tidak ketemu atau ambigu", async () => {
    const ws = freshWs();
    await writeFileHandler(ws)({ path: "d.txt", content: "aa bb aa" });
    const miss = (await editFileHandler(ws)({ path: "d.txt", search: "zz", replace: "q" })) as {
      error: string;
    };
    assert.ok(miss.error.includes("not found"));
    const amb = (await editFileHandler(ws)({ path: "d.txt", search: "aa", replace: "q" })) as {
      error: string;
    };
    assert.ok(amb.error.includes("2x"));
  });

  it("list / glob / grep menemukan file", async () => {
    const ws = freshWs();
    await writeFileHandler(ws)({ path: "src/app.ts", content: "export const answer = 42;\n" });
    const list = (await listDirectoryHandler(ws)({})) as { listing: string };
    assert.ok(list.listing.includes("src/"));
    assert.ok(list.listing.includes("src/app.ts"));
    const glob = (await globHandler(ws)({ pattern: "**/*.ts" })) as { results: string[] };
    assert.ok(glob.results.includes("src/app.ts"));
    const grep = (await grepHandler(ws)({ query: "answer" })) as {
      results: Array<{ file: string; line: number }>;
    };
    assert.equal(grep.results.length, 1);
    assert.equal(grep.results[0].file, "src/app.ts");
    assert.equal(grep.results[0].line, 1);
  });
});
