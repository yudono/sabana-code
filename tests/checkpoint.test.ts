import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckpoint, listCheckpoints, rewindToCheckpoint } from "../src/checkpoint.js";
import { createSession, type Session } from "../src/session/store.js";
import { closeDb } from "../src/db.js";

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "sc-cp-"));
  process.env.SABANA_HOME = home;
  closeDb();
  return home;
}

function sess(ws: string): Session {
  const s = createSession("m", "mock", ws);
  s.messages = [{ role: "user", content: "halo" }];
  return s;
}

describe("checkpoint & rewind", () => {
  it("buat + daftar checkpoint", () => {
    isolatedHome();
    const w = mkdtempSync(join(tmpdir(), "sc-cpws-"));
    writeFileSync(join(w, "a.txt"), "v1");
    const s = sess(w);
    s.filesModified = ["a.txt"];
    const cp = createCheckpoint(s, w, "sebelum refactor");
    assert.ok(cp.id.length > 0);
    assert.equal(cp.label, "sebelum refactor");
    const list = listCheckpoints(s.id);
    assert.equal(list.length, 1);
    assert.equal(list[0].files, 1);
  });

  it("rewind kembalikan isi file + riwayat", () => {
    isolatedHome();
    const w = mkdtempSync(join(tmpdir(), "sc-cpws-"));
    writeFileSync(join(w, "a.txt"), "v1");
    const s = sess(w);
    s.filesModified = ["a.txt"];
    const cp = createCheckpoint(s, w);
    // Ubah setelah checkpoint.
    writeFileSync(join(w, "a.txt"), "v2-rusak");
    writeFileSync(join(w, "baru.txt"), "sampah");
    const s2: Session = {
      ...s,
      messages: [...s.messages, { role: "user", content: "lanjut" }],
      filesModified: ["a.txt", "baru.txt"],
    };
    const { session: back, result } = rewindToCheckpoint(s2, w, cp.id);
    assert.equal(result.ok, true);
    assert.deepEqual(result.restored, ["a.txt"]);
    assert.equal(readFileSync(join(w, "a.txt"), "utf-8"), "v1");
    assert.equal(back.messages.length, 1);
    assert.deepEqual(back.filesModified, ["a.txt"]);
  });

  it("rewind hapus file yang belum ada saat checkpoint", () => {
    isolatedHome();
    const w = mkdtempSync(join(tmpdir(), "sc-cpws-"));
    const s = sess(w);
    // Checkpoint dengan filesModified berisi file yang BELUM ada → snapshot null.
    s.filesModified = ["nanti.txt"];
    const cp = createCheckpoint(s, w);
    writeFileSync(join(w, "nanti.txt"), "dibuat belakangan");
    const { result } = rewindToCheckpoint({ ...s, messages: s.messages }, w, cp.id);
    assert.equal(result.ok, true);
    assert.deepEqual(result.deleted, ["nanti.txt"]);
    assert.equal(existsSync(join(w, "nanti.txt")), false);
  });

  it("rewind id tak dikenal gagal jelas", () => {
    isolatedHome();
    const w = mkdtempSync(join(tmpdir(), "sc-cpws-"));
    const s = sess(w);
    const { result } = rewindToCheckpoint(s, w, "ngawur");
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("tidak ditemukan"));
  });
});
