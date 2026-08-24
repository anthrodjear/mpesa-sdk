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
  /** M-Pesa shortcode — digits-only, 5 to 10 characters. */
  readonly shortcode: string;
  /** Daraja passkey — non-empty string. */
  readonly passkey: string;
  /** Target environment (defaults to SANDBOX). */
  readonly environment: Environment;

  /**
   * Build a validated Config.
   * @throws {ConfigError} When any required field is missing or invalid.
   */
  constructor(opts: {
    consumerKey: string;
    consumerSecret: string;
    shortcode: string;
    passkey: string;
    environment?: Environment;
  }) {
    this.consumerKey = opts.consumerKey;
    this.consumerSecret = opts.consumerSecret;
    this.shortcode = opts.shortcode;
    this.passkey = opts.passkey;
    this.environment = opts.environment ?? Environment.SANDBOX;
    this.validate();
    Object.freeze(this);
  }

  /** Validate all fields — throws {@link ConfigError} on the first invalid. */
  validate(): void {
    validateField(this.consumerKey, "consumerKey", (v) => v.length > 0, "must be a non-empty string");
    validateField(this.consumerSecret, "consumerSecret", (v) => v.length > 0, "must be a non-empty string");
    validateField(this.shortcode, "shortcode", (v) => /^\d{5,10}$/.test(v),
      "must be a digits-only string of 5 to 10 characters");
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
