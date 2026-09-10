import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { detectLang, detectLangFromContent, highlight, stripAnsi } from "../src/tui/highlight.js";

describe("detectLang", () => {
  it("ekstensi umum", () => {
    assert.equal(detectLang("src/App.tsx"), "ts");
    assert.equal(detectLang("a.json"), "json");
    assert.equal(detectLang("run.sh"), "sh");
    assert.equal(detectLang("README.md"), "md");
    assert.equal(detectLang("main.py"), "py");
    assert.equal(detectLang("main.go"), "go");
    assert.equal(detectLang("lib.rs"), "rust");
    assert.equal(detectLang("app.yaml"), "yaml");
    assert.equal(detectLang("index.html"), "html");
    assert.equal(detectLang("a.css"), "css");
    assert.equal(detectLang("q.sql"), "sql");
    assert.equal(detectLang("notes.txt"), "plain");
    assert.equal(detectLang("Dockerfile"), "sh");
    assert.equal(detectLang("Makefile"), "sh");
  });

  it("konten: shebang & json & yaml & html", () => {
    assert.equal(detectLangFromContent("bin/jalan", "#!/usr/bin/env python3\nprint(1)\n"), "py");
    assert.equal(detectLangFromContent("bin/jalan", "#!/bin/bash\necho hi\n"), "sh");
    assert.equal(detectLangFromContent("data", '{"a": 1}'), "json");
    assert.equal(detectLangFromContent("cfg", "---\nname: x\n"), "yaml");
    assert.equal(detectLangFromContent("page", "<!doctype html><html>"), "html");
    // Path spesifik menang atas konten.
    assert.equal(detectLangFromContent("a.py", "hello"), "py");
  });

  it("stripAnsi buang escape shell", () => {
    assert.equal(stripAnsi("\x1b[32mok\x1b[0m\n"), "ok\n");
    assert.equal(stripAnsi("plain"), "plain");
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

  it("py/go/rust: keyword + komentar", () => {
    const [py] = highlight("def f(): # halo", "py");
    assert.ok(py.some((s) => s.text === "def" && s.color === "magenta"));
    assert.ok(py.some((s) => s.text === "# halo" && s.color === "gray"));
    const [go] = highlight("func main() {", "go");
    assert.ok(go.some((s) => s.text === "func" && s.color === "magenta"));
    const [rs] = highlight("fn main() { // hi", "rust");
    assert.ok(rs.some((s) => s.text === "fn" && s.color === "magenta"));
    const [sql] = highlight("select * from t", "sql");
    assert.ok(sql.some((s) => s.text === "select" && s.color === "magenta"));
  });

  it("plain: tanpa warna", () => {
    const [l] = highlight("teks biasa 123", "plain");
    assert.ok(l.every((s) => s.color === undefined));
  });

  it("baris kosong tetap satu segmen", () => {
    assert.deepEqual(highlight("", "ts"), [[{ text: "" }]]);
  });
});
