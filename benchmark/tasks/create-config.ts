import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import type { BenchmarkTask } from "../types.js";

export const task: BenchmarkTask = {
  id: "create-config",
  title: "Buat file config.json yang valid",
  prompt:
    "Buatkan file config.json di workspace dengan isi: name='demo-app', version='1.0.0', port=3000. " +
    "Pastikan JSON valid.",
  async verify(ws) {
    const raw = await readFile(`${ws}/config.json`, "utf-8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    assert.equal(cfg.name, "demo-app");
    assert.equal(cfg.version, "1.0.0");
    assert.equal(cfg.port, 3000);
  },
  mockPlan: [
    {
      name: "write_file",
      args: {
        path: "config.json",
        content: '{\n  "name": "demo-app",\n  "version": "1.0.0",\n  "port": 3000\n}\n',
      },
    },
  ],
};
