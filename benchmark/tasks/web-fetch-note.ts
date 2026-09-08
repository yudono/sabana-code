import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import type { BenchmarkTask } from "../types.js";

export const task: BenchmarkTask = {
  id: "web-fetch-note",
  title: "Riset web lalu simpan ringkasan ke file",
  prompt:
    "Ambil konten dari https://example.com memakai web_fetch, lalu simpan ringkasannya " +
    "(minimal judul domain-nya) ke file note.txt.",
  async verify(ws) {
    const note = await readFile(`${ws}/note.txt`, "utf-8");
    assert.ok(note.includes("Example Domain"), "note.txt tidak memuat hasil fetch");
  },
  mockPlan: [
    { name: "web_fetch", args: { url: "https://example.com", maxChars: 2000 } },
    {
      name: "write_file",
      args: {
        path: "note.txt",
        content: "Ringkasan example.com:\nJudul: Example Domain\nDomain untuk contoh dokumentasi.\n",
      },
    },
  ],
};
