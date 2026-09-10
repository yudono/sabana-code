import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BANNER_LINES, BANNER_TAGLINE, bannerSegs, hasChatItems, renderBigText } from "../src/tui/banner.js";

describe("banner ascii art", () => {
  it("semua baris sama lebar (center rapi) + berisi blok", () => {
    assert.ok(BANNER_LINES.length === 5, `tinggi banner = ${BANNER_LINES.length}`);
    const widths = new Set(BANNER_LINES.map((l) => [...l].length));
    assert.equal(widths.size, 1, `lebar tak konsisten: ${[...widths]}`);
    assert.ok(BANNER_LINES.some((l) => l.includes("█")));
    assert.ok(BANNER_TAGLINE.length > 0);
  });

  it("renderBigText deterministik per huruf", () => {
    const a1 = renderBigText("AB");
    const a2 = renderBigText("AB");
    assert.deepEqual(a1, a2);
    assert.equal(a1.length, 5);
    // Spasi = pemisah kata (blok kosong tapi posisi terjaga)
    assert.ok(renderBigText("A B")[0].length > renderBigText("AB")[0].length);
  });

  it("bannerSegs: judul bold + tagline dim", () => {
    const segs = bannerSegs();
    assert.ok(segs[0][0].bold);
    assert.ok(segs.some((ln) => ln.some((s) => s.dim && s.text.includes("/help"))));
  });
});

describe("hasChatItems", () => {
  it("info saja = belum ada chat", () => {
    assert.equal(hasChatItems([]), false);
    assert.equal(hasChatItems([{ kind: "info" }]), false);
  });

  it("user/assistant/tool = sudah ada chat", () => {
    assert.equal(hasChatItems([{ kind: "info" }, { kind: "user" }]), true);
    assert.equal(hasChatItems([{ kind: "assistant" }]), true);
    assert.equal(hasChatItems([{ kind: "tool" }]), true);
  });
});
