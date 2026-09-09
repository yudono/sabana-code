import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import type { BenchmarkTask } from "../types.js";

export const task: BenchmarkTask = {
  id: "rename-refactor",
  title: "Rename fungsi di semua file pemakai",
  prompt:
    "Rename fungsi getUserName menjadi getDisplayName di util.mjs DAN di semua file yang memakainya " +
    "(app.mjs). Pastikan tidak ada lagi referensi getUserName dan app.mjs tetap jalan.",
  async setup(ws) {
    await mkdir(ws, { recursive: true });
    await writeFile(
      `${ws}/util.mjs`,
      `export function getUserName(u) {\n  return \`\${u.first} \${u.last}\`;\n}\n`,
      "utf-8",
    );
    await writeFile(
      `${ws}/app.mjs`,
      `import { getUserName } from "./util.mjs";\nconsole.log(getUserName({ first: "A", last: "B" }));\n`,
      "utf-8",
    );
  },
  async verify(ws) {
    const util = await readFile(`${ws}/util.mjs`, "utf-8");
    const app = await readFile(`${ws}/app.mjs`, "utf-8");
    assert.ok(!util.includes("getUserName"), "util.mjs masih menyebut nama lama");
    assert.ok(!app.includes("getUserName"), "app.mjs masih menyebut nama lama");
    assert.ok(util.includes("getDisplayName"));
    assert.ok(app.includes("getDisplayName"));
    const out = execFileSync("node", [`${ws}/app.mjs`], { encoding: "utf-8", timeout: 15_000 }).trim();
    assert.equal(out, "A B");
  },
  mockPlan: [
    {
      name: "modified_file",
      args: { path: "util.mjs", search: "function getUserName(u)", replace: "function getDisplayName(u)" },
    },
    {
      name: "modified_file",
      args: {
        path: "app.mjs",
        search: 'import { getUserName } from "./util.mjs";',
        replace: 'import { getDisplayName } from "./util.mjs";',
      },
    },
    {
      name: "modified_file",
      args: { path: "app.mjs", search: "getUserName({", replace: "getDisplayName({" },
    },
  ],
};
