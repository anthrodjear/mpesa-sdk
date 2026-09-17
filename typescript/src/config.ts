/**
 * Configuration and credential management for the Daraja API — mirrors
 * go/config.go and python/mpesa/config.py. {@link Config} carries live
 * credentials so its text form can never leak them: {@link Config.toString}
 * shows `consumerKey` in CLEARTEXT (Go GoString parity) while
 * `consumerSecret`/`passkey` are omitted ENTIRELY; {@link Config.toJSON} /
 * {@link Config.logSafe} return the same secret-free dict for structured
 * logging (Python `log_safe` parity).
 *
 * `JSON.stringify(config)` invokes `toJSON()` and returns the redacted
 * form, so it is safe for structured logging. Environment-variable wiring
 * belongs to the Client layer. Safaricom requires IP whitelisting for
 * production credentials.
 *
 * @example
 * ```ts
 * import { Config, Environment } from "@mpesa-sdk/core";
 * const cfg = new Config({
 *   consumerKey: process.env.MPESA_CONSUMER_KEY!,
 *   consumerSecret: process.env.MPESA_CONSUMER_SECRET!,
 *   shortcode: process.env.MPESA_SHORTCODE!,
 *   passkey: process.env.MPESA_PASSKEY!,
 * });
 * ```
 * @packageDocumentation
 */

/**
 * Daraja platform environment — sandbox or production.
 *
 * @example
 * ```ts
 * console.log(Environment.SANDBOX.baseUrl); // https://sandbox.safaricom.co.ke
 * ```
 */
export class Environment {
  /** Canonical short name. */
  readonly name: string;
  /** API base URL for the platform. */
  readonly baseUrl: string;

  constructor(name: string, baseUrl: string) {
    this.name = name;
    this.baseUrl = baseUrl;
    Object.freeze(this);
  }

  /** Safe for development and testing. */
  static readonly SANDBOX = new Environment("sandbox", "https://sandbox.safaricom.co.ke");
  /** Live credentials only. */
  static readonly PRODUCTION = new Environment("production", "https://api.safaricom.co.ke");
  /** All defined environments. */
  static readonly ALL: readonly Environment[] = Object.freeze([
    Environment.SANDBOX, Environment.PRODUCTION,
  ]);

  toString(): string { return this.name; }
  toJSON(): string { return this.name; }
}

/**
 * Thrown when {@link Config} construction or validation fails. Message
 * includes the offending field name and the reason.
 *
 * @example
 * ```ts
 * try { new Config({ consumerKey: "", consumerSecret: "s", shortcode: "123", passkey: "pk" }); }
 * catch (e) { if (e instanceof ConfigError) console.error(e.message); }
 * ```
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
    Object.setPrototypeOf(this, ConfigError.prototype);
  }
}

/** Validate a field or throw {@link ConfigError}. */
function validateField(value: unknown, name: string, check: (v: string) => boolean, reason: string): void {
  if (typeof value !== "string" || !check(value)) throw new ConfigError(`mpesa: ${name}: ${reason}`);
}

/**
 * ASCII gate for credential fields (Go `Config.Validate` parity — the
 * Basic-auth `key:secret` pair is base64'd verbatim, so non-ASCII bytes
 * would sign a different credential than the dashboard shows).
 *
 * @param s - Candidate credential string.
 * @returns `true` when every code unit is ≤ 0x7F.
 */
function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

/**
 * Immutable, credential-safe configuration. Validates on construction and
 * never exposes `consumerSecret` or `passkey` in any text form.
 * `environment` defaults to {@link Environment.SANDBOX}.
 *
 * @example
 * ```ts
 * const cfg = new Config({
 *   consumerKey: "abcdefxy", consumerSecret: "mnopqrst",
 *   shortcode: "174379", passkey: "xyz789",
 * });
 * console.log(cfg.toString());
 * // Config(sandbox, shortcode=174379, key=abcdefxy)
 * // consumerKey is cleartext (Go GoString parity); secrets are omitted.
 * ```
 */
export class Config {
  /** OAuth consumer key — non-empty string. */
  readonly consumerKey: string;
  /** OAuth consumer secret — non-empty string. */
  readonly consumerSecret: string;
  /**
   * M-Pesa shortcode — digits-only, 5 to 10 characters, OR empty.
   * Empty is allowed (Go/Py parity) for callers that pass the shortcode
   * per-request instead of via config; validated only when non-empty.
   */
  readonly shortcode: string;
  /** Daraja passkey — non-empty string. */
  readonly passkey: string;
  /** Target environment (defaults to SANDBOX). */
  readonly environment: Environment;

  /**
   * Build a validated Config.
   *
   * `shortcode` is optional and defaults to `""` (Go/Python parity — an
   * empty shortcode means "supply it per-request"; endpoints that need one
   * inject `config.shortcode` only when the caller omits it). When
   * non-empty it must be 5–10 ASCII digits; `consumerKey` must be
   * non-empty ASCII with no `":"` (Basic-auth `key:secret` separator —
   * a colon would split credentials ambiguously at the gateway or a
   * forward proxy); `consumerSecret` must be non-empty ASCII.
   *
   * @throws {ConfigError} When any field is missing or invalid.
   *
   * @example
   * ```ts
   * // Per-request shortcode callers may omit it entirely:
   * const cfg = new Config({ consumerKey: "k", consumerSecret: "s", passkey: "p" });
   * cfg.shortcode; // ""
   * ```
   */
  constructor(opts: {
    consumerKey: string;
    consumerSecret: string;
    shortcode?: string;
    passkey: string;
    environment?: Environment;
  }) {
    this.consumerKey = opts.consumerKey;
    this.consumerSecret = opts.consumerSecret;
    this.shortcode = opts.shortcode ?? "";
    this.passkey = opts.passkey;
    this.environment = opts.environment ?? Environment.SANDBOX;
    this.validate();
    Object.freeze(this);
  }

  /**
   * Validate all fields — throws {@link ConfigError} on the first invalid.
   *
   * Rules (Go `Config.Validate` parity, plus the ASCII gate the TS
   * `TokenManager` already enforces so misconfiguration fails here and
   * not at first network I/O):
   * - `consumerKey`: non-empty string, ASCII-only, must not contain `":"`.
   * - `consumerSecret`: non-empty string, ASCII-only.
   * - `shortcode`: `""` (per-request mode) or 5–10 ASCII digits.
   * - `passkey`: non-empty string.
   */
  validate(): void {
    validateField(this.consumerKey, "consumerKey", (v) => v.length > 0, "must be a non-empty string");
    validateField(
      this.consumerKey,
      "consumerKey",
      (v) => !v.includes(":"),
      "must not contain ':' (Basic-auth key:secret separator)",
    );
    validateField(
      this.consumerKey,
      "consumerKey",
      (v) => isAscii(v),
      "must be ASCII-only",
    );
    validateField(this.consumerSecret, "consumerSecret", (v) => v.length > 0, "must be a non-empty string");
    validateField(
      this.consumerSecret,
      "consumerSecret",
      (v) => isAscii(v),
      "must be ASCII-only",
    );
    // Empty shortcode allowed (Go/Py parity) — callers may supply the
    // shortcode per-request; validate the shape only when non-empty.
    validateField(this.shortcode, "shortcode", (v) => v.length === 0 || /^\d{5,10}$/.test(v),
      "must be a digits-only string of 5 to 10 characters (or empty when passed per-request)");
    validateField(this.passkey, "passkey", (v) => v.length > 0, "must be a non-empty string");
  }

  /**
   * Credential-safe string: `Config(env, shortcode=XXXXXX, key=<cleartext>)`.
   * `consumerSecret` and `passkey` are omitted entirely (Go GoString +
   * Python `_redacted` convention: key shown, secrets redacted away).
   * @example
   * ```ts
   * log.info(cfg.toString()); // safe for human-readable logs
   * ```
   */
  toString(): string {
    return `Config(${this.environment.name}, shortcode=${this.shortcode}, key=${this.consumerKey})`;
  }

  /**
   * Secret-free object for structured logging: shortcode/environment/key.
   * `consumerSecret` and `passkey` are omitted entirely (Python
   * `log_safe()` parity).
   * @example
   * ```ts
   * logger.info(cfg.toJSON());
   * // { shortcode: "174379", environment: "sandbox", key: "abcdefxy" }
   * ```
   */
  toJSON(): { shortcode: string; environment: string; key: string } {
    return {
      shortcode: this.shortcode,
      environment: this.environment.name,
      key: this.consumerKey,
    };
  }

  /**
   * Alias for {@link Config.toJSON} — log-safe dict with no secrets.
   */
  logSafe(): { shortcode: string; environment: string; key: string } {
    return this.toJSON();
  }
}
