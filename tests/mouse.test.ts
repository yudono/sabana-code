import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMouseParser, stripMouseSequences, type MouseClick } from "../src/tui/mouse.js";

describe("mouse SGR parser", () => {
  it("klik kiri-tekan terdeteksi dengan koordinat 1-based", () => {
    const clicks: MouseClick[] = [];
    const feed = createMouseParser((c) => clicks.push(c));
    feed("halo\x1b[<0;10;20Mworld");
    assert.deepEqual(clicks, [{ x: 10, y: 20 }]);
  });

  it("lepas (m kecil), drag, wheel, tombol kanan diabaikan", () => {
    const clicks: MouseClick[] = [];
    const feed = createMouseParser((c) => clicks.push(c));
    feed("\x1b[<0;1;1m"); // lepas
    feed("\x1b[<32;1;1M"); // drag
    feed("\x1b[<64;1;1M"); // wheel up
    feed("\x1b[<2;1;1M"); // kanan
    feed("teks biasa tanpa mouse");
    assert.deepEqual(clicks, []);
  });

  it("sequence terpotong antar chunk tetap terbaca", () => {
    const clicks: MouseClick[] = [];
    const feed = createMouseParser((c) => clicks.push(c));
    feed("abc\x1b[<0;4");
    assert.deepEqual(clicks, []);
    feed("2;7Mdef");
    assert.deepEqual(clicks, [{ x: 42, y: 7 }]);
  });

  it("banyak klik dalam satu chunk", () => {
    const clicks: MouseClick[] = [];
    const feed = createMouseParser((c) => clicks.push(c));
    feed("\x1b[<0;1;2M\x1b[<0;3;4M");
    assert.deepEqual(clicks, [
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ]);
  });
});

describe("stripMouseSequences", () => {
  it("buang sequence lengkap, sisakan teks", () => {
    assert.equal(stripMouseSequences("a\x1b[<0;1;2Mb"), "ab");
    assert.equal(stripMouseSequences("bersih"), "bersih");
  });
});
