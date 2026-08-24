/**
 * Configuration and credential management for the Daraja API — mirrors
 * go/config.go and python/mpesa/config.py. {@link Config} carries live
 * credentials so its text form can never leak them: {@link Config.toString}
 * masks secrets; {@link Config.toJSON} / {@link Config.logSafe} return
 * redacted dicts for structured logging.
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

/** Mask a secret: first 4 + "**" + last 2. Short values become "**". */
function maskSecret(value: string): string {
  if (value.length < 6) return "**";
  return `${value.slice(0, 4)}**${value.slice(-2)}`;
}

/** Validate a field or throw {@link ConfigError}. */
function validateField(value: unknown, name: string, check: (v: string) => boolean, reason: string): void {
  if (typeof value !== "string" || !check(value)) throw new ConfigError(`mpesa: ${name}: ${reason}`);
}

/**
 * Immutable, credential-safe configuration. Validates on construction and
 * never exposes raw secrets in text form. `environment` defaults to
 * {@link Environment.SANDBOX}.
 *
 * @example
 * ```ts
 * const cfg = new Config({
 *   consumerKey: "abcdefxy", consumerSecret: "mnopqrst",
 *   shortcode: "174379", passkey: "xyz789",
 * });
 * console.log(cfg.toString());
 * // Config(sandbox, shortcode=174379, key=abcd**xy, secret=mnop**st)
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
   * Masked string: `Config(env, shortcode=XXXXXX, key=abcd**xy, secret=mnop**st)`.
   * @example
   * ```ts
   * log.info(cfg.toString()); // safe for human-readable logs
   * ```
   */
  toString(): string {
    return `Config(${this.environment.name}, shortcode=${this.shortcode}, ` +
      `key=${maskSecret(this.consumerKey)}, secret=${maskSecret(this.consumerSecret)})`;
  }

  /**
   * Redacted object for structured logging.
   * @example
   * ```ts
   * logger.info(cfg.toJSON());
   * // { shortcode: "174379", environment: "sandbox", key: "abcd**xy", secret: "mnop**st" }
   * ```
   */
  toJSON(): { shortcode: string; environment: string; key: string; secret: string } {
    return {
      shortcode: this.shortcode,
      environment: this.environment.name,
      key: maskSecret(this.consumerKey),
      secret: maskSecret(this.consumerSecret),
    };
  }

  /**
   * Alias for {@link Config.toJSON} — log-safe redacted dict.
   *
   * TS exposes masked partials for debugging (more useful than total
   * omission); Python omits key/secret entirely via `_redacted()`.
   */
  logSafe(): { shortcode: string; environment: string; key: string; secret: string } {
    return this.toJSON();
  }
}
