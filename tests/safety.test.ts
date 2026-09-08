import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../src/utils/ratelimit.js";
import { redactSecrets } from "../src/utils/guardrails.js";

describe("rate limiter", () => {
  it("mengizinkan sampai batas dalam satu window", async () => {
    const lim = new RateLimiter(3, 1_000);
    await lim.acquire();
    await lim.acquire();
    await lim.acquire();
    assert.equal(lim.usage().used, 3);
  });

  it("menahan acquire ke-(N+1) sampai window bergeser", async () => {
    const lim = new RateLimiter(2, 150);
    await lim.acquire();
    await lim.acquire();
    const t0 = Date.now();
    await lim.acquire();
    assert.ok(Date.now() - t0 >= 120, "seharusnya menunggu slot kosong");
  });

  it("rpm <= 0 berarti tanpa batas", async () => {
    const lim = new RateLimiter(0);
    for (let i = 0; i < 10; i++) await lim.acquire();
    assert.equal(lim.usage().used, 0);
  });

  it("abort saat menunggu menolak", async () => {
    const lim = new RateLimiter(1, 60_000);
    await lim.acquire();
    const c = new AbortController();
    const p = lim.acquire(c.signal);
    c.abort();
    await assert.rejects(p, /Abort/);
  });
});

describe("redactSecrets", () => {
  it("menyensor API key dan token", () => {
    const out = redactSecrets(`key=sk-abcdefghijklmnopqrst config api_key: "abc123xyz890" Bearer tokengoeshere123`);
    assert.ok(!out.includes("sk-abcdef"), "sk-* bocor");
    assert.ok(!out.includes("abc123xyz890"), "api_key bocor");
    assert.ok(!out.includes("tokengoeshere123"), "bearer bocor");
    assert.ok(out.includes("[REDACTED"), "penanda redaksi hilang");
  });

  it("menyensor private key multiline", () => {
    const out = redactSecrets("a\n-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\nb");
    assert.ok(!out.includes("MIIB"));
  });

  it("tidak merusak teks normal", () => {
    const s = "pakai token JWT untuk auth; baca file token.txt dulu";
    assert.equal(redactSecrets(s), s);
  });
});
