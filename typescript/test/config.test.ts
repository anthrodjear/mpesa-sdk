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
// Config.toString — masking alignment (Go GoString / Py _redacted convention)
// ---------------------------------------------------------------------------

describe("Config.toString", () => {
  const SECRET_KEY = "abcdefxy";
  const SECRET_SECRET = "mnopqrst";
  const SECRET_PASSKEY = "passkey-9f8e7d6c5b4a";

  function makeCfg() {
    return new Config({
      consumerKey: SECRET_KEY,
      consumerSecret: SECRET_SECRET,
      shortcode: "174379",
      passkey: SECRET_PASSKEY,
    });
  }

  it("shows consumerKey in CLEARTEXT (Go GoString parity)", () => {
    expect(makeCfg().toString()).toContain(`key=${SECRET_KEY}`);
  });

  it("omits consumerSecret entirely", () => {
    const s = makeCfg().toString();
    expect(s).not.toContain(SECRET_SECRET);
    expect(s).not.toContain("secret=");
  });

  it("omits passkey entirely", () => {
    const s = makeCfg().toString();
    expect(s).not.toContain(SECRET_PASSKEY);
    expect(s).not.toContain("passkey");
  });

  it("shows shortcode fully visible", () => {
    expect(makeCfg().toString()).toContain("shortcode=174379");
  });

  it("shows environment name", () => {
    expect(makeCfg().toString()).toMatch(/^Config\(sandbox,/);
  });

  it("format matches expected pattern", () => {
    expect(makeCfg().toString()).toBe(
      "Config(sandbox, shortcode=174379, key=abcdefxy)",
    );
  });
});

// ---------------------------------------------------------------------------
// Config.toJSON / logSafe — secrets omitted, key cleartext
// ---------------------------------------------------------------------------

describe("Config.toJSON / logSafe", () => {
  const SECRET_SECRET = "supersecretsecret123";
  const SECRET_PASSKEY = "supersecretpass";

  it("toJSON returns cleartext key and no secret fields", () => {
    const cfg = new Config({
      consumerKey: "abcdefxy",
      consumerSecret: SECRET_SECRET,
      shortcode: "174379",
      passkey: SECRET_PASSKEY,
    });
    const json = cfg.toJSON();
    expect(json).toEqual({
      shortcode: "174379",
      environment: "sandbox",
      key: "abcdefxy",
    });
    // Secret substrings never appear anywhere in the serialized form.
    const blob = JSON.stringify(json);
    expect(blob).not.toContain(SECRET_SECRET);
    expect(blob).not.toContain(SECRET_PASSKEY);
    expect(json).not.toHaveProperty("secret");
    expect(json).not.toHaveProperty("passkey");
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

  it("JSON.stringify of config omits secret and passkey substrings", () => {
    const cfg = new Config({
      consumerKey: "visible-consumer-key",
      consumerSecret: SECRET_SECRET,
      shortcode: "12345",
      passkey: SECRET_PASSKEY,
    });
    const serialized = JSON.stringify(cfg);
    expect(serialized).not.toContain(SECRET_SECRET);
    expect(serialized).not.toContain(SECRET_PASSKEY);
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
  const SECRET_SECRET = "short-secret";
  const SECRET_PASSKEY = "distinctive-passkey-xyz";

  function renderAll(cfg: Config): string {
    return cfg.toString() + JSON.stringify(cfg.toJSON()) + JSON.stringify(cfg.logSafe());
  }

  it("passkey never appears in any rendering, regardless of length", () => {
    const cfg = new Config({
      consumerKey: "12345",
      consumerSecret: SECRET_SECRET,
      shortcode: "12345",
      passkey: SECRET_PASSKEY,
    });
    expect(renderAll(cfg)).not.toContain(SECRET_PASSKEY);
    expect(renderAll(cfg)).not.toContain("passkey=");
  });

  it("consumerSecret never appears even when short", () => {
    const cfg = new Config({
      consumerKey: "abcdef",
      consumerSecret: SECRET_SECRET,
      shortcode: "12345",
      passkey: "p",
    });
    expect(renderAll(cfg)).not.toContain(SECRET_SECRET);
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

// ---------------------------------------------------------------------------
// Shortcode whitespace rejection
// ---------------------------------------------------------------------------

describe("shortcode whitespace rejection", () => {
  it("rejects shortcode with trailing newline", () => {
    expect(
      () =>
        new Config({
          consumerKey: "k",
          consumerSecret: "s",
          shortcode: "12345\n",
          passkey: "p",
        }),
    ).toThrow(ConfigError);
  });

  it("rejects shortcode with trailing tab", () => {
    expect(
      () =>
        new Config({
          consumerKey: "k",
          consumerSecret: "s",
          shortcode: "12345\t",
          passkey: "p",
        }),
    ).toThrow(ConfigError);
  });

  it("rejects shortcode with leading/trailing spaces", () => {
    expect(
      () =>
        new Config({
          consumerKey: "k",
          consumerSecret: "s",
          shortcode: " 12345 ",
          passkey: "p",
        }),
    ).toThrow(ConfigError);
  });
});

// ---------------------------------------------------------------------------
// toJSON passkey omission
// ---------------------------------------------------------------------------

describe("toJSON passkey omission", () => {
  it("toJSON does not include passkey", () => {
    const cfg = new Config({
      consumerKey: "k",
      consumerSecret: "s",
      shortcode: "12345",
      passkey: "my-secret-passkey",
    });
    const json = cfg.toJSON();
    expect(json).not.toHaveProperty("passkey");
  });
});

// ---------------------------------------------------------------------------
// ConfigError passkey field name
// ---------------------------------------------------------------------------

describe("ConfigError passkey field name", () => {
  it("message includes the field name for passkey", () => {
    try {
      new Config({
        consumerKey: "k",
        consumerSecret: "s",
        shortcode: "12345",
        passkey: "",
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).message).toContain("passkey");
    }
  });
});

// ---------------------------------------------------------------------------
// Immutability (Object.freeze)
// ---------------------------------------------------------------------------

describe("immutability", () => {
  it("Environment instances are frozen", () => {
    expect(Object.isFrozen(Environment.SANDBOX)).toBe(true);
    expect(Object.isFrozen(Environment.PRODUCTION)).toBe(true);
  });

  it("Config instances are frozen", () => {
    const cfg = new Config({
      consumerKey: "k",
      consumerSecret: "s",
      shortcode: "12345",
      passkey: "p",
    });
    expect(Object.isFrozen(cfg)).toBe(true);
  });
});
