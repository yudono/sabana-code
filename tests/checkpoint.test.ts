import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCheckpoint, listCheckpoints, pairPromptCheckpoints, rewindToCheckpoint } from "../src/checkpoint.js";
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
  it("create + list checkpoints", () => {
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

  it("rewind restores file contents + history", () => {
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

  it("rewind deletes files missing at checkpoint time", () => {
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

  it("unknown rewind id fails clearly", () => {
    isolatedHome();
    const w = mkdtempSync(join(tmpdir(), "sc-cpws-"));
    const s = sess(w);
    const { result } = rewindToCheckpoint(s, w, "ngawur");
    assert.equal(result.ok, false);
    assert.ok(result.error?.includes("not found"));
  });

  it("binary files skipped (never deleted on rewind)", () => {
    isolatedHome();
    const w = mkdtempSync(join(tmpdir(), "sc-cpws-"));
    writeFileSync(join(w, "bin.dat"), Buffer.from([0x00, 0x01, 0x02, 0x41]));
    const s = sess(w);
    s.filesModified = ["bin.dat"];
    const cp = createCheckpoint(s, w);
    // Ubah biner setelah checkpoint → rewind tidak boleh menyentuh/diubah.
    writeFileSync(join(w, "bin.dat"), Buffer.from([0x00, 0x09, 0x09]));
    const { result } = rewindToCheckpoint({ ...s, messages: s.messages }, w, cp.id);
    assert.equal(result.ok, true);
    assert.deepEqual(result.restored, []);
    assert.deepEqual(result.skipped, ["bin.dat"]);
    assert.deepEqual([...readFileSync(join(w, "bin.dat"))], [0x00, 0x09, 0x09]);
  });
});
describe("pairPromptCheckpoints (right-click revert)", () => {
  const cps = (labels: string[]) => labels.map((label, i) => ({ id: `cp${i}`, label, createdAt: `2026-01-0${i + 1}T00:00:00.000Z` }));

  it("pairs prompts to checkpoints in order", () => {
    const m = pairPromptCheckpoints(["alpha", "beta"], cps(["alpha", "beta"]));
    assert.equal(m.get(0), "cp0");
    assert.equal(m.get(1), "cp1");
  });

  it("duplicate texts pair in order (1st → 1st)", () => {
    const m = pairPromptCheckpoints(["same", "same"], cps(["same", "same"]));
    assert.equal(m.get(0), "cp0");
    assert.equal(m.get(1), "cp1");
  });

  it("sub-agent messages never get checkpoints", () => {
    const m = pairPromptCheckpoints(["[sub-agent reviewer] check", "real"], cps(["real"]));
    assert.equal(m.has(0), false);
    assert.equal(m.get(1), "cp0");
  });

  it("pruned prompts get no pair", () => {
    const m = pairPromptCheckpoints(["gone", "here"], cps(["here"]));
    assert.equal(m.has(0), false);
    assert.equal(m.get(1), "cp0");
  });

  it("labels truncate at 80 chars like createCheckpoint", () => {
    const long = "x".repeat(100);
    const m = pairPromptCheckpoints([long], cps([long.slice(0, 80)]));
    assert.equal(m.get(0), "cp0");
  });
});
