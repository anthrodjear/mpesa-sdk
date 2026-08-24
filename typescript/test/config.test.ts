/**
 * Tests for src/config.ts — Environment, Config, ConfigError validation,
 * masked string output, and log-safe rendering.
 *
 * Mirrors go/config.go (GoString/Format redaction) and python/mpesa/config.py
 * (_redacted/log_safe) translated to TypeScript's class-based approach.
 */
import { describe, expect, it } from "vitest";
import { Environment, Config, ConfigError } from "../src/config.js";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

describe("Environment", () => {
  it("SANDBOX has correct name and baseUrl", () => {
    expect(Environment.SANDBOX.name).toBe("sandbox");
    expect(Environment.SANDBOX.baseUrl).toBe("https://sandbox.safaricom.co.ke");
  });

  it("PRODUCTION has correct name and baseUrl", () => {
    expect(Environment.PRODUCTION.name).toBe("production");
    expect(Environment.PRODUCTION.baseUrl).toBe("https://api.safaricom.co.ke");
  });

  it("ALL contains SANDBOX and PRODUCTION", () => {
    expect(Environment.ALL).toHaveLength(2);
    expect(Environment.ALL).toContain(Environment.SANDBOX);
    expect(Environment.ALL).toContain(Environment.PRODUCTION);
  });

  it("ALL is frozen", () => {
    expect(Object.isFrozen(Environment.ALL)).toBe(true);
  });

  it("toString returns name", () => {
    expect(Environment.SANDBOX.toString()).toBe("sandbox");
    expect(Environment.PRODUCTION.toString()).toBe("production");
  });

  it("toJSON returns name for serialization", () => {
    expect(JSON.stringify(Environment.SANDBOX)).toBe('"sandbox"');
    expect(JSON.stringify(Environment.PRODUCTION)).toBe('"production"');
  });

  it("equality by reference", () => {
    expect(Environment.SANDBOX).toBe(Environment.SANDBOX);
    expect(Environment.PRODUCTION).toBe(Environment.PRODUCTION);
    // Two distinct instances with same args are NOT equal
    const dup = new Environment("sandbox", "https://sandbox.safaricom.co.ke");
    expect(dup).not.toBe(Environment.SANDBOX);
  });
});

// ---------------------------------------------------------------------------
// Config construction — valid cases
// ---------------------------------------------------------------------------

describe("Config construction — valid", () => {
  it("accepts all valid fields with default environment", () => {
    const cfg = new Config({
      consumerKey: "abcdef",
      consumerSecret: "mnopqr",
      shortcode: "174379",
      passkey: "xyz789",
    });
    expect(cfg.consumerKey).toBe("abcdef");
    expect(cfg.consumerSecret).toBe("mnopqr");
    expect(cfg.shortcode).toBe("174379");
    expect(cfg.passkey).toBe("xyz789");
    expect(cfg.environment).toBe(Environment.SANDBOX);
  });

  it("defaults environment to SANDBOX when omitted", () => {
    const cfg = new Config({
      consumerKey: "k",
      consumerSecret: "s",
      shortcode: "12345",
      passkey: "p",
    });
    expect(cfg.environment).toBe(Environment.SANDBOX);
  });

  it("accepts explicit PRODUCTION environment", () => {
    const cfg = new Config({
      consumerKey: "k",
      consumerSecret: "s",
      shortcode: "12345",
      passkey: "p",
      environment: Environment.PRODUCTION,
    });
    expect(cfg.environment).toBe(Environment.PRODUCTION);
  });

  it("accepts shortcodes of length 5 and 10", () => {
    expect(() =>
      new Config({
        consumerKey: "k",
        consumerSecret: "s",
        shortcode: "12345",
        passkey: "p",
      }),
    ).not.toThrow();
    expect(() =>
      new Config({
        consumerKey: "k",
        consumerSecret: "s",
        shortcode: "1234567890",
        passkey: "p",
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Config construction — invalid cases
// ---------------------------------------------------------------------------

describe("Config construction — invalid", () => {
  it("throws ConfigError for empty consumerKey", () => {
    expect(
      () =>
        new Config({
          consumerKey: "",
          consumerSecret: "s",
          shortcode: "174379",
          passkey: "p",
        }),
    ).toThrow(ConfigError);
  });

  it("throws ConfigError for empty consumerSecret", () => {
    expect(
      () =>
        new Config({
          consumerKey: "k",
          consumerSecret: "",
          shortcode: "174379",
          passkey: "p",
        }),
    ).toThrow(ConfigError);
  });

  it("throws ConfigError for empty passkey", () => {
    expect(
      () =>
        new Config({
          consumerKey: "k",
          consumerSecret: "s",
          shortcode: "174379",
          passkey: "",
        }),
    ).toThrow(ConfigError);
  });

  it("throws ConfigError for shortcode with non-digit characters", () => {
    expect(
      () =>
        new Config({
          consumerKey: "k",
          consumerSecret: "s",
          shortcode: "abc123",
          passkey: "p",
        }),
    ).toThrow(ConfigError);
  });

  it("throws ConfigError for shortcode shorter than 5 digits", () => {
    expect(
      () =>
        new Config({
          consumerKey: "k",
          consumerSecret: "s",
          shortcode: "1234",
          passkey: "p",
        }),
    ).toThrow(ConfigError);
  });

  it("throws ConfigError for shortcode longer than 10 digits", () => {
    expect(
      () =>
        new Config({
          consumerKey: "k",
          consumerSecret: "s",
          shortcode: "12345678901",
          passkey: "p",
        }),
    ).toThrow(ConfigError);
  });

  it("throws ConfigError for non-string consumerKey", () => {
    expect(
      () =>
        new Config({
          consumerKey: 123 as unknown as string,
          consumerSecret: "s",
          shortcode: "174379",
          passkey: "p",
        }),
    ).toThrow(ConfigError);
  });
});

// ---------------------------------------------------------------------------
// ConfigError — message includes field name
// ---------------------------------------------------------------------------

describe("ConfigError", () => {
  it("message includes the field name for consumerKey", () => {
    try {
      new Config({
        consumerKey: "",
        consumerSecret: "s",
        shortcode: "174379",
        passkey: "p",
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toContain("consumerKey");
    }
  });

  it("message includes the field name for shortcode", () => {
    try {
      new Config({
        consumerKey: "k",
        consumerSecret: "s",
        shortcode: "bad",
        passkey: "p",
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toContain("shortcode");
    }
  });

  it("error name is ConfigError", () => {
    const err = new ConfigError("test");
    expect(err.name).toBe("ConfigError");
    expect(err).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// Config.toString — masking
// ---------------------------------------------------------------------------

describe("Config.toString", () => {
  it("masks consumerKey and consumerSecret", () => {
    const cfg = new Config({
      consumerKey: "abcdefxy",
      consumerSecret: "mnopqrst",
      shortcode: "174379",
      passkey: "pk123",
    });
    const s = cfg.toString();
    expect(s).toContain("key=abcd**xy");
    expect(s).toContain("secret=mnop**st");
    expect(s).not.toContain("abcdefxy");
    expect(s).not.toContain("mnopqrst");
  });

  it("shows shortcode fully visible", () => {
    const cfg = new Config({
      consumerKey: "k",
      consumerSecret: "s",
      shortcode: "174379",
      passkey: "p",
    });
    expect(cfg.toString()).toContain("shortcode=174379");
  });

  it("shows environment name", () => {
    const cfg = new Config({
      consumerKey: "k",
      consumerSecret: "s",
      shortcode: "174379",
      passkey: "p",
    });
    expect(cfg.toString()).toMatch(/^Config\(sandbox,/);
  });

  it("format matches expected pattern", () => {
    const cfg = new Config({
      consumerKey: "abcdefxy",
      consumerSecret: "mnopqrst",
      shortcode: "174379",
      passkey: "pk123",
    });
    expect(cfg.toString()).toBe(
      "Config(sandbox, shortcode=174379, key=abcd**xy, secret=mnop**st)",
    );
  });
});

// ---------------------------------------------------------------------------
// Config.toJSON / logSafe — redacted
// ---------------------------------------------------------------------------

describe("Config.toJSON / logSafe", () => {
  it("toJSON returns redacted keys", () => {
    const cfg = new Config({
      consumerKey: "abcdefxy",
      consumerSecret: "mnopqrst",
      shortcode: "174379",
      passkey: "pk123",
    });
    const json = cfg.toJSON();
    expect(json.key).toBe("abcd**xy");
    expect(json.secret).toBe("mnop**st");
    expect(json.shortcode).toBe("174379");
    expect(json.environment).toBe("sandbox");
    // Full secrets are never present
    expect(JSON.stringify(json)).not.toContain("abcdefxy");
    expect(JSON.stringify(json)).not.toContain("mnopqrst");
  });

  it("logSafe returns the same shape as toJSON", () => {
    const cfg = new Config({
      consumerKey: "key123456",
      consumerSecret: "sec123456",
      shortcode: "99999",
      passkey: "pass999",
    });
    expect(cfg.logSafe()).toEqual(cfg.toJSON());
  });

  it("JSON.stringify of config does not leak full secrets", () => {
    const cfg = new Config({
      consumerKey: "supersecretkey123",
      consumerSecret: "supersecretsecret123",
      shortcode: "12345",
      passkey: "supersecretpass",
    });
    // toJSON() is the default serialization
    const serialized = JSON.stringify(cfg);
    expect(serialized).not.toContain("supersecretkey123");
    expect(serialized).not.toContain("supersecretsecret123");
  });
});

// ---------------------------------------------------------------------------
// Config.validate — standalone
// ---------------------------------------------------------------------------

describe("Config.validate", () => {
  it("does not throw for valid config", () => {
    const cfg = new Config({
      consumerKey: "k",
      consumerSecret: "s",
      shortcode: "12345",
      passkey: "p",
    });
    expect(() => cfg.validate()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("passkey of fewer than 6 chars is masked to **", () => {
    const cfg = new Config({
      consumerKey: "12345",
      consumerSecret: "12345",
      shortcode: "12345",
      passkey: "p",
    });
    // Short secrets (<6 chars) become "**"
    expect(cfg.toString()).toContain("key=**");
    expect(cfg.toString()).toContain("secret=**");
  });

  it("secrets of exactly 6 chars get full mask pattern", () => {
    const cfg = new Config({
      consumerKey: "abcdef",
      consumerSecret: "mnopqr",
      shortcode: "12345",
      passkey: "p",
    });
    expect(cfg.toString()).toContain("key=abcd**ef");
    expect(cfg.toString()).toContain("secret=mnop**qr");
  });

  it("shortcode boundary: exactly 5 and 10 digits are valid", () => {
    expect(
      () =>
        new Config({
          consumerKey: "k",
          consumerSecret: "s",
          shortcode: "11111",
          passkey: "p",
        }),
    ).not.toThrow();
    expect(
      () =>
        new Config({
          consumerKey: "k",
          consumerSecret: "s",
          shortcode: "1111111111",
          passkey: "p",
        }),
    ).not.toThrow();
  });
});
