import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import type { BenchmarkTask } from "../types.js";

const HELLO_JS = `const i = process.argv.indexOf("--name");
const name = i >= 0 ? process.argv[i + 1] || "dunia" : "dunia";
console.log(\`Halo, \${name}!\`);
`;

export const task: BenchmarkTask = {
  id: "scaffold-cli",
  title: "Scaffold CLI kecil yang bisa dijalankan",
  prompt:
    "Buatkan file hello.js: CLI node yang menerima argumen --name dan mencetak 'Halo, <name>!'. " +
    "Tanpa --name, cetak 'Halo, dunia!'.",
  async verify(ws) {
    const out = execFileSync("node", [`${ws}/hello.js`, "--name", "Sabana"], {
      encoding: "utf-8",
      timeout: 15_000,
    }).trim();
    assert.equal(out, "Halo, Sabana!");
    const def = execFileSync("node", [`${ws}/hello.js`], {
      encoding: "utf-8",
      timeout: 15_000,
    }).trim();
    assert.equal(def, "Halo, dunia!");
  },
  mockPlan: [{ name: "write_file", args: { path: "hello.js", content: HELLO_JS } }],
};
