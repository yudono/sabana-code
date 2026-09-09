import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDiff,
  deleteFileHandler,
  modifiedFileHandler,
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
    const r = (await modifiedFileHandler(ws)({ path: "c.txt", search: "bar", replace: "baz" })) as {
      edited: boolean;
    };
    assert.equal(r.edited, true);
    const back = (await readFileHandler(ws)({ path: "c.txt" })) as { content: string };
    assert.ok(back.content.includes("foo baz"));
  });

  it("edit gagal bila search tidak ketemu atau ambigu", async () => {
    const ws = freshWs();
    await writeFileHandler(ws)({ path: "d.txt", content: "aa bb aa" });
    const miss = (await modifiedFileHandler(ws)({ path: "d.txt", search: "zz", replace: "q" })) as {
      error: string;
    };
    assert.ok(miss.error.includes("not found"));
    const amb = (await modifiedFileHandler(ws)({ path: "d.txt", search: "aa", replace: "q" })) as {
      error: string;
    };
    assert.ok(amb.error.includes("2x"));
  });

  it("modified mengembalikan unified diff", async () => {
    const ws = freshWs();
    await writeFileHandler(ws)({ path: "e.txt", content: "satu\ndua\ntiga\nempat\nlima\n" });
    const r = (await modifiedFileHandler(ws)({ path: "e.txt", search: "tiga", replace: "TIGA!" })) as {
      edited: boolean;
      added: number;
      removed: number;
      diff: string;
    };
    assert.equal(r.edited, true);
    assert.equal(r.added, 1);
    assert.equal(r.removed, 1);
    assert.ok(r.diff.includes("--- e.txt"));
    assert.ok(r.diff.includes("+++ e.txt"));
    assert.ok(r.diff.includes("-tiga"));
    assert.ok(r.diff.includes("+TIGA!"));
    assert.ok(r.diff.includes(" satu")); // konteks
  });

  it("buildDiff: hunk header + konteks benar untuk ganti multi-baris", () => {
    const oldC = ["a", "b", "c", "d", "e", "f", "g", "h"].join("\n");
    const newC = ["a", "b", "X", "Y", "e", "f", "g", "h"].join("\n");
    const d = buildDiff("f.txt", oldC, newC);
    assert.equal(d.added, 2);
    assert.equal(d.removed, 2);
    assert.ok(d.diff.includes("@@ -1,7 +1,7 @@"));
    assert.ok(d.diff.includes("-c"));
    assert.ok(d.diff.includes("-d"));
    assert.ok(d.diff.includes("+X"));
    assert.ok(d.diff.includes("+Y"));
    assert.ok(d.diff.includes(" e"));
  });

  it("delete menghapus file, menolak direktori berisi & path kabur", async () => {
    const ws = freshWs();
    await writeFileHandler(ws)({ path: "del.txt", content: "x" });
    await writeFileHandler(ws)({ path: "sub/isi.txt", content: "y" });
    const okDel = (await deleteFileHandler(ws)({ path: "del.txt" })) as { deleted: boolean };
    assert.equal(okDel.deleted, true);
    const gone = (await deleteFileHandler(ws)({ path: "del.txt" })) as { error: string };
    assert.ok(gone.error.includes("not found"));
    const nonEmpty = (await deleteFileHandler(ws)({ path: "sub" })) as { error: string };
    assert.ok(nonEmpty.error.includes("non-empty"));
    const esc = (await deleteFileHandler(ws)({ path: "../luar.txt" })) as { error: string; denied: boolean };
    assert.equal(esc.denied, true);
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
