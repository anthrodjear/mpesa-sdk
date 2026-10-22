/**
 * Configuration and credential management for the Daraja API — mirrors
 * go/config.go and python/mpesa/config.py. {@link Config} carries live
 * credentials so its text form can never leak them: {@link Config.toString}
 * shows `consumerKey` MASKED (first-4/last-4) while `consumerSecret` and
 * `passkey` are omitted ENTIRELY; {@link Config.toJSON} /
 * {@link Config.logSafe} return the same secret-free dict for structured
 * logging (Python `log_safe` parity). SECURITY.md forbids cleartext
 * credentials in logs, so no rendering — human-readable or structured —
 * ever exposes the key.
 *
 * `JSON.stringify(config)` invokes `toJSON()` and returns the redacted
 * form, so it is safe for structured logging. `util.inspect` — and
 * therefore `console.log` — is intercepted by the
 * `nodejs.util.inspect.custom` hook installed below the class, so
 * `console.log(config)` never prints the raw object.
 *
 * `console.dir(config)` is NOT covered by that hook: Node documents it
 * as `util.inspect(obj, { ...options, customInspect: false })` — it
 * DISABLES the custom inspect hook — so the default walk would print
 * the consumer secret and the passkey in cleartext. `consumerSecret`
 * and `passkey` are therefore NON-ENUMERABLE own properties: the
 * default inspect walk and an object spread (`{ ...config }`) skip
 * them, so neither can leak a secret. The values stay readable
 * (`config.consumerSecret`) and the public shape is unchanged.
 *
 * Environment-variable wiring belongs to the Client layer. Safaricom
 * requires IP whitelisting for production credentials.
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

import {
  DEFAULT_TRANSACTION_LIMITS,
  LIMIT_SERVICE_KEYS,
  resolveTransactionLimits,
  type PartialTransactionLimits,
  type TransactionLimits,
} from "./limits.js";

/**
 * Daraja platform base URLs this SDK is willing to mint tokens against.
 * The base URL MUST arrive from trusted config (Environment.SANDBOX or
 * Environment.PRODUCTION) — never from user input — so an attacker host
 * can neither harvest the Basic-auth credential nor receive it via
 * redirect. Trailing slashes are stripped before the membership test.
 * Mirrors python/mpesa/auth.py `_TRUSTED_BASE_URLS` and go/config.go
 * `trustedBaseURLs`.
 */
export const TRUSTED_BASE_URLS: ReadonlySet<string> = new Set([
  "https://sandbox.safaricom.co.ke",
  "https://api.safaricom.co.ke",
]);

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
 * Mask a credential for human-readable logs: first 4 + last 4 characters
 * with an ASCII ellipsis between (`abcd…wxyz` → stored as `abcd...wxyz`).
 * Values of 8 characters or fewer collapse to `"****"` — with that little
 * material, any reveal is a full reveal.
 *
 * Parity target with the Go/Python redaction fixes (same first-4/last-4
 * shape); masks the `consumerKey` everywhere it is rendered for logging.
 * SECURITY.md forbids cleartext credentials in logs, so the historical
 * "key in cleartext (Go GoString parity)" behavior is retired here.
 *
 * @param value - Raw credential string.
 * @returns The masked, log-safe form.
 */
function maskCredential(value: string): string {
  if (value.length <= 8) return "****";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

/**
 * Immutable, credential-safe configuration. Validates on construction and
 * never exposes `consumerSecret` or `passkey` in any text form.
 * `consumerKey` is rendered MASKED (first-4/last-4) in every log
 * rendering — see {@link maskCredential}. `environment` defaults to
 * {@link Environment.SANDBOX}; `limits` defaults to
 * {@link DEFAULT_TRANSACTION_LIMITS} (see {@link resolveTransactionLimits}
 * for why ceilings come from config, not constants).
 *
 * @example
 * ```ts
 * const cfg = new Config({
 *   consumerKey: "abcdefxy", consumerSecret: "mnopqrst",
 *   shortcode: "174379", passkey: "xyz789",
 *   // Upgraded B2C tier — raise the ceiling, no SDK upgrade needed:
 *   limits: { b2c: { maxPerTransaction: 700_000 } },
 *   trackDaily: false,
 * });
 * console.log(cfg.toString());
 * // Config(sandbox, shortcode=174379, key=abcd...efxy)
 * ```
 */
export class Config {
  /** OAuth consumer key — non-empty string. */
  readonly consumerKey: string;
  /**
   * OAuth consumer secret — non-empty string.
   *
   * NON-ENUMERABLE own property: the default `util.inspect` walk (which
   * `console.dir` forces by disabling the custom inspect hook) and an
   * object spread skip it, so the secret cannot leak through either.
   * The value stays readable as `cfg.consumerSecret` — only the
   * enumerability changes, never the public shape.
   */
  readonly consumerSecret: string;
  /**
   * M-Pesa shortcode — digits-only, 5 to 10 characters, OR empty.
   * Empty is allowed (Go/Py parity) for callers that pass the shortcode
   * per-request instead of via config; validated only when non-empty.
   */
  readonly shortcode: string;
  /**
   * Daraja passkey — non-empty string.
   *
   * NON-ENUMERABLE own property, like {@link Config.consumerSecret}: the
   * default `util.inspect` walk and an object spread skip it, so the
   * passkey cannot leak through `console.dir(cfg)` or `{ ...cfg }`.
   */
  readonly passkey: string;
  /** Target environment (defaults to SANDBOX). */
  readonly environment: Environment;
  /**
   * Effective per-service transaction limits (never null). Always the
   * full merge of the caller's partial over
   * {@link DEFAULT_TRANSACTION_LIMITS} — omitted/partial input is safe
   * because the merge fills every service and field.
   */
  readonly limits: TransactionLimits;
  /**
   * Daily accumulation opt-in. OFF by default: one process cannot see
   * other replicas sharing the shortcode, so a local accumulator
   * under-counts and would falsely reject in-ceiling traffic.
   */
  readonly trackDaily: boolean;
  /** Raw (pre-merge) limits argument, kept only for shape validation. */
  private readonly _rawLimits: PartialTransactionLimits | undefined;

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
   * @param opts.limits - Optional partial per-service limits, merged over
   *   {@link DEFAULT_TRANSACTION_LIMITS} (any subset is safe; omitted or
   *   non-positive fields fall back to the defaults / UNLIMITED).
   * @param opts.trackDaily - Opt into local per-day (Africa/Nairobi)
   *   accumulation. OFF by default — see {@link Config.trackDaily}.
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
    limits?: PartialTransactionLimits;
    trackDaily?: boolean;
  }) {
    this.consumerKey = opts.consumerKey;
    this.consumerSecret = opts.consumerSecret;
    this.shortcode = opts.shortcode ?? "";
    this.passkey = opts.passkey;
    // The two SECRET fields are re-declared NON-ENUMERABLE.
    //
    // The `nodejs.util.inspect.custom` hook below covers `util.inspect`
    // and therefore `console.log`, but Node documents `console.dir` as
    // `util.inspect(obj, { ...options, customInspect: false })` — it
    // DISABLES the custom hook — so the default walk would print the
    // consumer secret and the passkey in cleartext. A non-enumerable own
    // property is skipped by that walk AND by an object spread
    // (`{ ...config }`), so neither can leak a secret.
    //
    // A redefine of an existing configurable data property keeps its
    // value/writable/configurable attributes, so ONLY `enumerable` moves
    // and the value assigned above is preserved. The public API is
    // unchanged: `cfg.consumerSecret` and `cfg.passkey` still read back
    // exactly what was passed in.
    Object.defineProperty(this, "consumerSecret", { enumerable: false });
    Object.defineProperty(this, "passkey", { enumerable: false });
    this.environment = opts.environment ?? Environment.SANDBOX;
    this.limits = resolveTransactionLimits(opts.limits);
    // Deep-freeze the resolved limits (and each nested service bucket):
    // Object.freeze(this) below alone leaves cfg.limits.stk untouched, so
    // cfg.limits.stk.maxPerTransaction = 1 would silently succeed and break
    // the immutable/resolve-once contract. Freezing in place preserves the
    // resolution identity (already-resolved objects keep their marker).
    for (const key of LIMIT_SERVICE_KEYS) {
      Object.freeze(this.limits[key]);
    }
    Object.freeze(this.limits);
    this._rawLimits = opts.limits;
    this.trackDaily = opts.trackDaily ?? false;
    this.validate();
    Object.freeze(this);
  }

  /**
   * Validate the OPTIONAL raw limits shape (pre-merge): every present
   * ceiling must be a NUMBER. Type errors are loud here — a typo'd string
   * is a {@link ConfigError} instead of a silent fallback — while VALUE
   * normalization (`0`/negative/non-finite → UNLIMITED) belongs to
   * `resolveTransactionLimits`, which is the single resolution point.
   *
   * @throws {ConfigError} When a supplied ceiling is not a number.
   */
  private validateLimits(): void {
    // The raw (pre-merge) argument is re-derived here rather than stored:
    // Config keeps the normalized merge, and this guard only rejects
    // malformed TYPES before normalization would quietly repair them.
    for (const key of LIMIT_SERVICE_KEYS) {
      const svc = this._rawLimits?.[key];
      if (svc === undefined) continue;
      for (const field of ["maxPerTransaction", "maxPerDay"] as const) {
        const value = svc[field];
        if (value === undefined) continue;
        if (typeof value !== "number") {
          throw new ConfigError(
            `mpesa: limits.${key}.${field} must be a number (0 = unlimited), got ${JSON.stringify(value)}`,
          );
        }
      }
    }
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
   * - `limits` (when supplied): every present ceiling must be a NUMBER —
   *   non-numeric shapes are rejected loudly; `0`/negative/non-finite
   *   values normalize to UNLIMITED in `resolveTransactionLimits`.
   */
  validate(): void {
    this.validateLimits();
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
    // Trusted-URL allowlist: the OAuth leg sends the Basic-auth credential
    // to environment.baseUrl — reject any non-allowlisted host before any
    // network use. Trailing slashes are stripped before the membership test
    // (Python auth.py parity). Environment.baseUrl is derived from the
    // Environment class, so this is a defense-in-depth guard against future
    // Environment modifications.
    const baseURL = this.environment.baseUrl.replace(/\/+$/, "");
    if (!TRUSTED_BASE_URLS.has(baseURL)) {
      throw new ConfigError(
        `mpesa: refusing untrusted base_url ${JSON.stringify(baseURL)} ` +
        `(want https://sandbox.safaricom.co.ke or https://api.safaricom.co.ke)`,
      );
    }
  }

  /**
   * Credential-safe string: `Config(env, shortcode=XXXXXX, key=abcd...wxyz)`.
   * `consumerKey` is MASKED to first-4/last-4 (SECURITY.md: never log
   * credentials); `consumerSecret` and `passkey` are omitted entirely.
   * @example
   * ```ts
   * log.info(cfg.toString()); // safe for human-readable logs
   * ```
   */
  toString(): string {
    return `Config(${this.environment.name}, shortcode=${this.shortcode}, key=${maskCredential(this.consumerKey)})`;
  }

  /**
   * Secret-free object for structured logging: shortcode/environment/masked key.
   * `consumerSecret` and `passkey` are omitted entirely (Python
   * `log_safe()` parity); the key is first-4/last-4 masked.
   * @example
   * ```ts
   * logger.info(cfg.toJSON());
   * // { shortcode: "174379", environment: "sandbox", key: "abcd...efxy" }
   * ```
   */
  toJSON(): { shortcode: string; environment: string; key: string } {
    return {
      shortcode: this.shortcode,
      environment: this.environment.name,
      key: maskCredential(this.consumerKey),
    };
  }

  /**
   * Alias for {@link Config.toJSON} — log-safe dict with no secrets.
   */
  logSafe(): { shortcode: string; environment: string; key: string } {
    return this.toJSON();
  }
}

/**
 * `util.inspect` hook — the TypeScript equivalent of Go's `Config.Format`
 * (go/config.go) and Python's `__repr__` (python/mpesa/config.py).
 *
 * `util.inspect` does NOT consult `toString()`/`toJSON()`: left to its own
 * devices it walks the own enumerable properties and prints `consumerSecret`
 * and `passkey` in cleartext, which is exactly what `console.log(cfg)` does.
 * SECURITY.md forbids cleartext credentials in logs, so the hook routes
 * `inspect` (and therefore `console.log`) through the redacted
 * {@link Config.toString} form.
 *
 * Installed with `Symbol.for("nodejs.util.inspect.custom")` rather than an
 * import of `node:util`, so this module keeps no Node-only import.
 */
Object.defineProperty(Config.prototype, Symbol.for("nodejs.util.inspect.custom"), {
  value(this: Config): string { return this.toString(); },
  enumerable: false, configurable: true, writable: true,
});
