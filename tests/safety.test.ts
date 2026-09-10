import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter } from "../src/utils/ratelimit.js";
import { redactSecrets } from "../src/utils/guardrails.js";

describe("rate limiter", () => {
  it("allows up to the cap within one window", async () => {
    const lim = new RateLimiter(3, 1_000);
    await lim.acquire();
    await lim.acquire();
    await lim.acquire();
    assert.equal(lim.usage().used, 3);
  });

  it("holds acquire #(N+1) until the window slides", async () => {
    const lim = new RateLimiter(2, 150);
    await lim.acquire();
    await lim.acquire();
    const t0 = Date.now();
    await lim.acquire();
    assert.ok(Date.now() - t0 >= 120, "seharusnya menunggu slot kosong");
  });

  it("rpm <= 0 means unlimited", async () => {
    const lim = new RateLimiter(0);
    for (let i = 0; i < 10; i++) await lim.acquire();
    assert.equal(lim.usage().used, 0);
  });

  it("abort while waiting refuses", async () => {
    const lim = new RateLimiter(1, 60_000);
    await lim.acquire();
    const c = new AbortController();
    const p = lim.acquire(c.signal);
    c.abort();
    await assert.rejects(p, /Abort/);
  });
});

describe("redactSecrets", () => {
  it("redacts API keys and tokens", () => {
    const out = redactSecrets(`key=sk-abcdefghijklmnopqrst config api_key: "abc123xyz890" Bearer tokengoeshere123`);
    assert.ok(!out.includes("sk-abcdef"), "sk-* leaked");
    assert.ok(!out.includes("abc123xyz890"), "api_key leaked");
    assert.ok(!out.includes("tokengoeshere123"), "bearer leaked");
    assert.ok(out.includes("[REDACTED"), "redaction marker missing");
  });

  it("redacts multiline private keys", () => {
    const out = redactSecrets("a\n-----BEGIN RSA PRIVATE KEY-----\nMIIB\n-----END RSA PRIVATE KEY-----\nb");
    assert.ok(!out.includes("MIIB"));
  });

  it("redacts AWS, Stripe, npm, and Slack secrets", () => {
    // Built via concatenation so no secret-shaped literal sits in the repo
    // (GitHub push protection would block it).
    const stripeKey = "sk_live_" + "4eC39HqLyjWDarjtT1zdp7dc";
    const out = redactSecrets([
      "aws AKIAIOSFODNN7EXAMPLE here",
      `stripe ${stripeKey}`,
      "npm npm_abcdefghijklmnopqrstuvwxyz0123456789 and more",
      "slack xoxb-123456789012-abcdefghij and xoxs-secret-token-value",
      "aws_secret_access_key = wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    ].join("\n"));
    assert.ok(!out.includes("AKIAIOSFODNN7EXAMPLE"), "aws key leaked");
    assert.ok(!out.includes(stripeKey), "stripe key leaked");
    assert.ok(!out.includes("abcdefghijklmnopqrstuvwxyz0123"), "npm token leaked");
    assert.ok(!out.includes("xoxb-123456789012"), "slack token leaked");
    assert.ok(!out.includes("wJalrXUtnFEMI"), "aws secret leaked");
  });

  it("leaves normal text intact", () => {
    const s = "use a JWT token for auth; read token.txt first";
    assert.equal(redactSecrets(s), s);
  });
});
