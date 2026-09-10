import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSkillsContext, listSkills, loadSkill, skillHandler } from "../src/skills.js";
import { closeDb } from "../src/db.js";

function isolatedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "sc-skills-"));
  process.env.SABANA_HOME = home;
  closeDb();
  return home;
}

const SKILL_MD = `---
name: commit
description: Tulis commit message
---

# Commit
Aturan main.
`;

describe("skills", () => {
  it("list kosong bila tak ada skill", () => {
    isolatedHome();
    assert.deepEqual(listSkills(), []);
    assert.equal(buildSkillsContext(), "");
  });

  it("baca skill global dari ~/sabana-code/skills", () => {
    const home = isolatedHome();
    mkdirSync(join(home, "skills"), { recursive: true });
    writeFileSync(join(home, "skills", "commit.md"), SKILL_MD);
    const list = listSkills();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "commit");
    assert.equal(list[0].scope, "global");
    assert.ok(list[0].instructions.includes("Aturan main"));
  });

  it("skill project menimpa global bila nama sama", () => {
    const home = isolatedHome();
    mkdirSync(join(home, "skills"), { recursive: true });
    writeFileSync(join(home, "skills", "commit.md"), SKILL_MD);
    const ws = mkdtempSync(join(tmpdir(), "sc-ws-"));
    mkdirSync(join(ws, ".sabana", "skills"), { recursive: true });
    writeFileSync(join(ws, ".sabana", "skills", "commit.md"), SKILL_MD.replace("Aturan main.", "Aturan project."));
    const list = listSkills(ws);
    assert.equal(list.length, 1);
    assert.equal(list[0].scope, "project");
    assert.ok(list[0].instructions.includes("Aturan project"));
    assert.ok(buildSkillsContext(ws).includes("commit"));
  });

  it("skillHandler: nama invalid & tak ada ditolak jelas", async () => {
    isolatedHome();
    const h = skillHandler("/tmp");
    assert.ok((await h({ name: "../../x" }) as { error: string }).error.includes("Invalid"));
    assert.ok((await h({ name: "takada" }) as { error: string }).error.includes("tidak ada"));
  });

  it("skillHandler: muat isi penuh", async () => {
    const home = isolatedHome();
    mkdirSync(join(home, "skills"), { recursive: true });
    writeFileSync(join(home, "skills", "commit.md"), SKILL_MD);
    const h = skillHandler("/tmp");
    const r = (await h({ name: "commit" })) as { name: string; instructions: string };
    assert.equal(r.name, "commit");
    assert.ok(r.instructions.includes("Aturan main"));
  });

  it("loadSkill case-insensitive", () => {
    const home = isolatedHome();
    mkdirSync(join(home, "skills"), { recursive: true });
    writeFileSync(join(home, "skills", "commit.md"), SKILL_MD);
    assert.ok(loadSkill("COMMIT"));
  });
});
