import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import type { BenchmarkTask } from "../types.js";

const BUGGY = `export function average(nums) {
  let s = 0;
  for (const n of nums) s += n;
  return s / (nums.length + 1);
}
`;

export const task: BenchmarkTask = {
  id: "fix-bug",
  title: "Perbaiki off-by-one di fungsi average",
  prompt:
    "File calc.mjs punya fungsi average(nums) yang hasilnya salah (pembagi tidak tepat). " +
    "Baca file-nya, perbaiki bug-nya, dan pastikan average([2, 4]) = 3.",
  async setup(ws) {
    await mkdir(ws, { recursive: true });
    await writeFile(`${ws}/calc.mjs`, BUGGY, "utf-8");
  },
  async verify(ws) {
    const content = await readFile(`${ws}/calc.mjs`, "utf-8");
    assert.ok(!content.includes("length + 1"), "bug masih ada di file");
    const out = execFileSync(
      "node",
      ["--input-type=module", "-e", `import(${JSON.stringify(`${ws}/calc.mjs`)}).then(m => console.log(m.average([2,4])))`],
      { encoding: "utf-8", timeout: 15_000 },
    ).trim();
    assert.equal(out, "3");
  },
  mockPlan: [
    { name: "read_file", args: { path: "calc.mjs" } },
    {
      name: "edit_file",
      args: { path: "calc.mjs", search: "nums.length + 1", replace: "nums.length" },
    },
  ],
  timeoutMs: 120_000,
};
