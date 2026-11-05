/**
 * The safety gate that stands between the real-Redis OTP suite and anything
 * that is not a throwaway server on this machine.
 *
 * A gate that is never exercised is a gate you cannot rely on: if it were to
 * start ACCEPTING a remote host, the suite would write and delete keys in
 * shared infrastructure. These tests pin the refusals, and they run with no
 * Redis, no network and no side effects.
 */
import { evaluateDisposableRedisTarget, redisTestNamespace } from "../helpers/localRedisTarget";

const withAmbientRedisUrl = <T>(url: string | undefined, fn: () => T): T => {
  const previous = process.env.REDIS_URL;
  if (url === undefined) delete process.env.REDIS_URL;
  else process.env.REDIS_URL = url;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previous;
  }
};

describe("evaluateDisposableRedisTarget — refusals", () => {
  it("refuses when nothing is configured", () => {
    const d = evaluateDisposableRedisTarget(undefined);
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/OTP_TEST_REDIS_URL is not set/);
    // The message must tell the operator how to fix it.
    expect(d.reason).toMatch(/127\.0\.0\.1/);
  });

  it("refuses an empty or whitespace value", () => {
    expect(evaluateDisposableRedisTarget("").ok).toBe(false);
    expect(evaluateDisposableRedisTarget("   ").ok).toBe(false);
  });

  it("refuses an unparseable value", () => {
    expect(evaluateDisposableRedisTarget("not a url").ok).toBe(false);
  });

  it("refuses a non-loopback host", () => {
    for (const url of [
      "redis://10.0.0.5:6379/15",
      "redis://192.168.1.10:6379/15",
      "redis://redis.internal:6379/15",
      // The application's own configured endpoint shape.
      "rediss://frankfurt-keyvalue.render.com:6379/0",
    ]) {
      const d = evaluateDisposableRedisTarget(url);
      expect(d.ok).toBe(false);
      expect(d.reason).toMatch(/scheme|loopback/);
    }
  });

  it("refuses TLS even on loopback", () => {
    const d = evaluateDisposableRedisTarget("rediss://127.0.0.1:6379/15");
    expect(d.ok).toBe(false);
    expect(d.reason).toMatch(/scheme/);
  });

  it("refuses database 0 and a missing database index", () => {
    for (const url of ["redis://127.0.0.1:6399", "redis://127.0.0.1:6399/", "redis://127.0.0.1:6399/0"]) {
      const d = evaluateDisposableRedisTarget(url);
      expect(d.ok).toBe(false);
      expect(d.reason).toMatch(/database/i);
    }
  });

  it("refuses an endpoint that matches the application's REDIS_URL", () => {
    withAmbientRedisUrl("redis://127.0.0.1:6379/0", () => {
      const d = evaluateDisposableRedisTarget("redis://127.0.0.1:6379/15");
      expect(d.ok).toBe(false);
      expect(d.reason).toMatch(/shared infrastructure/);
    });
  });

  it("never echoes a credential in the refusal reason", () => {
    const d = evaluateDisposableRedisTarget("redis://user:hunter2@10.0.0.5:6379/15");
    expect(d.ok).toBe(false);
    expect(d.reason ?? "").not.toContain("hunter2");
  });
});

describe("evaluateDisposableRedisTarget — acceptances", () => {
  it("accepts a loopback host on a dedicated database", () => {
    const d = evaluateDisposableRedisTarget("redis://127.0.0.1:6399/15");
    expect(d.ok).toBe(true);
    expect(d.url).toBe("redis://127.0.0.1:6399/15");
    expect(d.description).toMatch(/127\.0\.0\.1:6399/);
    expect(d.description).toMatch(/database 15/);
  });

  it("accepts localhost and the IPv6 loopback", () => {
    expect(evaluateDisposableRedisTarget("redis://localhost:6399/9").ok).toBe(true);
    expect(evaluateDisposableRedisTarget("redis://[::1]:6399/9").ok).toBe(true);
  });

  it("accepts a loopback target that is not the application's endpoint", () => {
    withAmbientRedisUrl("rediss://frankfurt-keyvalue.render.com:6379/0", () => {
      const d = evaluateDisposableRedisTarget("redis://127.0.0.1:6399/15");
      expect(d.ok).toBe(true);
    });
  });

  it("tolerates an unparseable ambient REDIS_URL without opening a hole", () => {
    withAmbientRedisUrl("://broken", () => {
      // Loopback + non-default database checks still stand.
      expect(evaluateDisposableRedisTarget("redis://127.0.0.1:6399/15").ok).toBe(true);
      expect(evaluateDisposableRedisTarget("redis://127.0.0.1:6399/0").ok).toBe(false);
      expect(evaluateDisposableRedisTarget("redis://10.1.2.3:6399/15").ok).toBe(false);
    });
  });
});

describe("evaluateDisposableRedisTarget — same-endpoint comparison (canonical loopback + port)", () => {
  it("accepts 127.0.0.1:6399/15 when the application uses 127.0.0.1:6379", () => {
    // Distinct port, distinct process, dedicated database: a genuinely
    // different endpoint, not the application's Redis.
    withAmbientRedisUrl("redis://127.0.0.1:6379/0", () => {
      const d = evaluateDisposableRedisTarget("redis://127.0.0.1:6399/15");
      expect(d.ok).toBe(true);
    });
  });

  it("rejects the application's own host and port even with a dedicated database", () => {
    withAmbientRedisUrl("redis://127.0.0.1:6379/0", () => {
      const d = evaluateDisposableRedisTarget("redis://127.0.0.1:6379/15");
      expect(d.ok).toBe(false);
      expect(d.reason).toMatch(/shared infrastructure/);
    });
  });

  it("rejects an alias spelling of the application's endpoint", () => {
    // 127.0.0.2 is the same machine. A hostname-only comparison in either
    // direction must not decide this; canonical host plus port must.
    withAmbientRedisUrl("redis://127.0.0.2:6379/0", () => {
      expect(evaluateDisposableRedisTarget("redis://127.0.0.1:6379/15").ok).toBe(false);
    });
    withAmbientRedisUrl("redis://localhost:6379/0", () => {
      expect(evaluateDisposableRedisTarget("redis://127.0.0.1:6379/15").ok).toBe(false);
    });
    withAmbientRedisUrl("redis://127.0.0.1:6379/0", () => {
      expect(evaluateDisposableRedisTarget("redis://localhost:6379/15").ok).toBe(false);
    });
  });

  it("keeps refusing remote and malformed candidates regardless of ambient", () => {
    withAmbientRedisUrl("redis://127.0.0.1:6379/0", () => {
      expect(evaluateDisposableRedisTarget("redis://10.1.2.3:6399/15").ok).toBe(false);
      expect(evaluateDisposableRedisTarget("rediss://127.0.0.1:6399/15").ok).toBe(false);
      expect(evaluateDisposableRedisTarget("redis://127.0.0.1:6399/0").ok).toBe(false);
    });
  });

  it("redacts credentials when refusing the application's endpoint", () => {
    withAmbientRedisUrl("redis://:s3cret@127.0.0.1:6379/0", () => {
      const d = evaluateDisposableRedisTarget("redis://operator:s3cret@127.0.0.1:6379/15");
      expect(d.ok).toBe(false);
      expect(d.reason ?? "").not.toContain("s3cret");
    });
  });
});

describe("redisTestNamespace", () => {
  it("scopes keys per process so concurrent runs cannot collide", () => {
    const a = redisTestNamespace("argv");
    const b = redisTestNamespace("argv");
    expect(a).toBe(b);
    expect(a).toContain(String(process.pid));
    expect(a.startsWith("otp:itest:")).toBe(true);
    // A wildcard sweep built from it can only match this run's keys.
    expect(`${redisTestNamespace("*")}`).toBe(`otp:itest:${process.pid}:*`);
  });
});