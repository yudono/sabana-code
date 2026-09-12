import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isSafeShellCommand } from "../src/tools/shellPolicy.js";

describe("isSafeShellCommand", () => {
  it("read-only commands need no approval", () => {
    for (const c of ["ls", "ls -la", "cd /tmp", "pwd", "echo halo", "cat a.txt", "head -5 f", "ls && pwd", "cd x; ls -la", "echo a | grep b", "command ls -la", "VAR=1 env"]) {
      assert.equal(isSafeShellCommand(c), true, c);
    }
  });

  it("dangerous/write commands ask approval", () => {
    for (const c of ["rm -rf x", "mkdir a", "npm install", "npm run build", "npm test", "git status", "node a.js", "sudo ls", "find . -delete", "sed -i s/a/b/ f", "python x.py", "curl https://x", ""]) {
      assert.equal(isSafeShellCommand(c), false, c);
    }
  });

  it("dangerous operators always ask approval", () => {
    for (const c of ["ls && rm -rf /", "echo hi; rm x", "ls | tee out.txt", "ls > out.txt", "cat < in.txt", "echo $(whoami)", "echo `id`"]) {
      assert.equal(isSafeShellCommand(c), false, c);
    }
  });
});
