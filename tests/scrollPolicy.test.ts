import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSafeShellCommand } from "../src/tools/shellPolicy.js";
import { computeWindow } from "../src/tui/App.js";

describe("isSafeShellCommand", () => {
  it("perintah baca saja bebas izin", () => {
    for (const c of ["ls", "ls -la", "cd /tmp", "pwd", "echo halo", "cat a.txt", "head -5 f", "ls && pwd", "cd x; ls -la", "echo a | grep b", "command ls -la", "VAR=1 env"]) {
      assert.equal(isSafeShellCommand(c), true, c);
    }
  });

  it("perintah berbahaya/penulis minta izin", () => {
    for (const c of ["rm -rf x", "mkdir a", "npm install", "npm run build", "npm test", "git status", "node a.js", "sudo ls", "find . -delete", "sed -i s/a/b/ f", "python x.py", "curl https://x", ""]) {
      assert.equal(isSafeShellCommand(c), false, c);
    }
  });

  it("operator berbahaya selalu minta izin", () => {
    for (const c of ["ls && rm -rf /", "echo hi; rm x", "ls | tee out.txt", "ls > out.txt", "cat < in.txt", "echo $(whoami)", "echo `id`"]) {
      assert.equal(isSafeShellCommand(c), false, c);
    }
  });
});

describe("computeWindow", () => {
  it("scroll 0 → ekor menempel bawah", () => {
    const r = computeWindow([2, 2, 2, 2, 2], 6, 0);
    assert.deepEqual([r.start, r.end], [2, 5]);
    assert.equal(r.scroll, 0);
  });

  it("scroll naik menggeser jendela ke atas", () => {
    const r = computeWindow([2, 2, 2, 2, 2], 6, 4);
    assert.deepEqual([r.start, r.end], [0, 3]);
    assert.equal(r.scroll, 4);
  });

  it("scroll dijepit ke maksimum", () => {
    const r = computeWindow([2, 2, 2], 6, 999);
    assert.deepEqual([r.start, r.end], [0, 3]);
    assert.equal(r.scroll, 0); // total 6 <= avail 6 → max 0
  });

  it("item sebagian tidak dirender (mencegah overlap)", () => {
    // total 10, avail 6, scroll 3 → lewati idx4 utuh + idx3 parsial dibuang → end=3,
    // lalu ambil mundur idx2,idx1,idx0 (6 baris) → [0,3)
    const r = computeWindow([2, 2, 2, 2, 2], 6, 3);
    assert.deepEqual([r.start, r.end], [0, 3]);
    assert.equal(r.scroll, 3);
  });

  it("scroll tepat di batas item tidak membuang ekstra", () => {
    // scroll 4 = tepat 2 item → end=3 tanpa dec, ambil idx2,1,0 → [0,3)
    const r = computeWindow([2, 2, 2, 2, 2], 6, 4);
    assert.deepEqual([r.start, r.end], [0, 3]);
  });

  it("feed kosong → jendela kosong (bukan blank misterius)", () => {
    const r = computeWindow([], 10, 0);
    assert.deepEqual([r.start, r.end, r.total], [0, 0, 0]);
  });

  it("semua muat → tampil semua", () => {
    const r = computeWindow([1, 2, 3], 10, 0);
    assert.deepEqual([r.start, r.end], [0, 3]);
  });
});
