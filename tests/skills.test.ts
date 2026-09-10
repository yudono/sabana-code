import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
  it("empty list when no skills exist", () => {
    isolatedHome();
    assert.deepEqual(listSkills(), []);
    assert.equal(buildSkillsContext(), "");
  });

  it("reads global skills from ~/sabana-code/skills", () => {
    const home = isolatedHome();
    mkdirSync(join(home, "skills"), { recursive: true });
    writeFileSync(join(home, "skills", "commit.md"), SKILL_MD);
    const list = listSkills();
    assert.equal(list.length, 1);
    assert.equal(list[0].name, "commit");
    assert.equal(list[0].scope, "global");
    assert.ok(list[0].instructions.includes("Aturan main"));
  });

  it("project skills override global ones on name clash", () => {
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

  it("skillHandler: invalid & missing names rejected clearly", async () => {
    isolatedHome();
    const h = skillHandler("/tmp");
    assert.ok((await h({ name: "../../x" }) as { error: string }).error.includes("Invalid"));
    assert.ok((await h({ name: "takada" }) as { error: string }).error.includes("not found"));
  });

  it("skillHandler: loads full content", async () => {
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

  it("built-in skills ship valid frontmatter + instructions", () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "skills");
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
    assert.ok(files.length >= 8, `expected 8+ built-in skills, got ${files.length}`);
    for (const f of files) {
      const raw = readFileSync(join(dir, f), "utf-8");
      const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
      assert.ok(m, `${f}: missing frontmatter`);
      assert.match(m[1], /name:\s*\S+/, `${f}: missing name`);
      assert.match(m[1], /description:\s*\S+/, `${f}: missing description`);
      assert.ok((m[2] || "").trim().length > 100, `${f}: instructions too short`);
    }
  });
});
