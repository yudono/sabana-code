import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createMouseParser, stripMouseSequences, type MouseClick } from "../src/tui/mouse.js";

describe("mouse SGR parser", () => {
  it("left-press clicks detected with 1-based coordinates", () => {
    const clicks: MouseClick[] = [];
    const feed = createMouseParser((c) => clicks.push(c));
    feed("halo\x1b[<0;10;20Mworld");
    assert.deepEqual(clicks, [{ x: 10, y: 20 }]);
  });

  it("release (lowercase m), drag, right/middle buttons are not clicks", () => {
    const clicks: MouseClick[] = [];
    const feed = createMouseParser((c) => clicks.push(c));
    feed("\x1b[<0;1;1m"); // lepas
    feed("\x1b[<32;1;1M"); // drag
    feed("\x1b[<2;1;1M"); // kanan
    feed("\x1b[<1;1;1M"); // tengah
    feed("teks biasa tanpa mouse");
    assert.deepEqual(clicks, []);
  });

  it("wheel gestures (cb 64/65) → onWheel up/down, not clicks", () => {
    const clicks: MouseClick[] = [];
    const wheels: string[] = [];
    const feed = createMouseParser(
      (c) => clicks.push(c),
      (d) => wheels.push(d),
    );
    feed("\x1b[<64;10;20M\x1b[<64;10;20M\x1b[<65;10;20M");
    assert.deepEqual(clicks, []);
    assert.deepEqual(wheels, ["up", "up", "down"]);
  });

  it("right press (cb 2) → onRightClick, not onClick", () => {
    const clicks: MouseClick[] = [];
    const rights: MouseClick[] = [];
    const feed = createMouseParser(
      (c) => clicks.push(c),
      undefined,
      (c) => rights.push(c),
    );
    feed("\x1b[<2;10;20M\x1b[<2;10;20m");
    assert.deepEqual(rights, [{ x: 10, y: 20 }]);
    assert.deepEqual(clicks, []);
  });

  it("without onRightClick: right press ignored (legacy compat)", () => {
    const clicks: MouseClick[] = [];
    const feed = createMouseParser((c) => clicks.push(c));
    feed("\x1b[<2;1;1M");
    assert.deepEqual(clicks, []);
  });

  it("sequences split across chunks still parse", () => {
    const clicks: MouseClick[] = [];
    const feed = createMouseParser((c) => clicks.push(c));
    feed("abc\x1b[<0;4");
    assert.deepEqual(clicks, []);
    feed("2;7Mdef");
    assert.deepEqual(clicks, [{ x: 42, y: 7 }]);
  });

  it("multiple clicks in one chunk", () => {
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
  it("strips complete sequences, keeps text", () => {
    assert.equal(stripMouseSequences("a\x1b[<0;1;2Mb"), "ab");
    assert.equal(stripMouseSequences("bersih"), "bersih");
  });

  it("strips orphan remnants without ESC (Ink ate the ESC)", () => {
    assert.equal(stripMouseSequences("a[<0;54;45mb"), "ab");
    assert.equal(stripMouseSequences("[<64;64;29M[<64;64;29m"), "");
  });
});
