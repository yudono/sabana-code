import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectLang, highlight } from "../src/tui/highlight.js";

describe("detectLang", () => {
  it("ekstensi umum", () => {
    assert.equal(detectLang("src/App.tsx"), "ts");
    assert.equal(detectLang("a.json"), "json");
    assert.equal(detectLang("run.sh"), "sh");
    assert.equal(detectLang("README.md"), "md");
    assert.equal(detectLang("main.py"), "code");
    assert.equal(detectLang("notes.txt"), "plain");
    assert.equal(detectLang("Dockerfile"), "sh");
  });
});

describe("highlight ts", () => {
  it("keyword, string, angka, komentar", () => {
    const [l1] = highlight("const x = 42; // halo", "ts");
    assert.ok(l1.some((s) => s.text === "const" && s.color === "magenta"));
    assert.ok(l1.some((s) => s.text === "42" && s.color === "yellow"));
    assert.ok(l1.some((s) => s.text === "// halo" && s.color === "gray"));
    const [s] = highlight(`const a = "hi";`, "ts");
    assert.ok(s.some((x) => x.text === '"hi"' && x.color === "green"));
  });

  it("tipe kapital jadi cyan", () => {
    const [l] = highlight("function f(x: string): Promise<void> {}", "ts");
    assert.ok(l.some((s) => s.text === "Promise" && s.color === "cyan"));
  });
});

describe("highlight diff", () => {
  it("prefix + hijau, - merah, @@ cyan, konteks dim", () => {
    const [plus] = highlight("+tambah", "diff");
    assert.equal(plus[0].color, "green");
    const [minus] = highlight("-kurang", "diff");
    assert.equal(minus[0].color, "red");
    const [hunk] = highlight("@@ -1,3 +1,4 @@", "diff");
    assert.equal(hunk[0].color, "cyan");
    const [ctx] = highlight(" konteks", "diff");
    assert.equal(ctx[0].dim, true);
  });
});

describe("highlight json/md/sh", () => {
  it("json: kunci hijau, bool magenta", () => {
    const [l] = highlight('{"a": true}', "json");
    assert.ok(l.some((s) => s.color === "green"));
    assert.ok(l.some((s) => s.text === "true" && s.color === "magenta"));
  });

  it("md: heading bold + inline code hijau", () => {
    const [h] = highlight("# Judul", "md");
    assert.ok(h[0].bold);
    const [b] = highlight("pakai `code` di sini", "md");
    assert.ok(b.some((s) => s.text === "`code`" && s.color === "green"));
  });

  it("sh: komentar abu, keyword sh", () => {
    const [l] = highlight("# komen", "sh");
    assert.equal(l[0].color, "gray");
  });

  it("plain: tanpa warna", () => {
    const [l] = highlight("teks biasa 123", "plain");
    assert.ok(l.every((s) => s.color === undefined));
  });

  it("baris kosong tetap satu segmen", () => {
    assert.deepEqual(highlight("", "ts"), [[{ text: "" }]]);
  });
});
