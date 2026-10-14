/**
 * Configurable per-merchant transaction limits — mirrors the Go/Python
 * `limits` module from the same cross-language spec.
 *
 * WHY CONFIGURABLE (not hardcoded): Safaricom raises a merchant's ceiling
 * per TIER, and tiers are dynamic per-merchant — a constant baked into the
 * SDK (e.g. the historical B2C `250_000`) rejects legitimately upgraded
 * merchants with a local error the gateway would never have raised, and
 * the only workaround is an SDK upgrade. Every ceiling therefore arrives
 * from {@link Config}; this module holds only the DEFAULTS, the merge
 * semantics, and the enforcement helpers.
 *
 * WHY DAILY TRACKING IS OPT-IN (`trackDaily`, default OFF): one process
 * cannot observe other replicas sharing the same shortcode, so a local
 * accumulator UNDER-counts real usage and would falsely reject traffic
 * that is still inside the merchant's true daily ceiling. Callers who
 * know they run a single instance (or a single allocator of the shortcode)
 * can opt in; everyone else keeps the per-transaction ceiling only.
 *
 * Semantics (identical across the three SDKs):
 * - `undefined` / `0` for any ceiling means UNLIMITED for that ceiling.
 * - Negative / non-finite values normalize to UNLIMITED (never to a
 *   silently tight ceiling); {@link Config} rejects non-numeric shapes.
 * - Resolution happens ONCE, at {@link Config} construction; the client
 *   consumes the resolved object and never re-resolves per request (a
 *   re-resolve would let ceiling values drift between calls).
 * - Resolution is IDEMPOTENT: feeding a resolved object back in returns
 *   it unchanged, so UNLIMITED fields survive config copies.
 * - Per-transaction checks fail fast BEFORE any network I/O.
 * - Daily checks roll at Africa/Nairobi midnight (UTC+3, no DST).
 *
 * @packageDocumentation
 */

import { MpesaError } from "./errors.js";

/** Ceiling for one service; `undefined`/`0` = UNLIMITED for that ceiling. */
export interface ServiceLimits {
  /** Maximum whole-KES amount for a single transaction (0 = unlimited). */
  maxPerTransaction?: number;
  /** Maximum whole-KES amount accumulated per Africa/Nairobi day (0 = unlimited). */
  maxPerDay?: number;
}

/** Per-service limits plus the fallback bucket for unclassified services. */
export interface TransactionLimits {
  /** STK Push (`Lipa Na M-Pesa Online`). */
  stk: ServiceLimits;
  /** C2B (register / simulate). */
  c2b: ServiceLimits;
  /** B2C (Business to Customer payouts). */
  b2c: ServiceLimits;
  /** Reversal. */
  reversal: ServiceLimits;
  /** Dynamic QR. */
  qr: ServiceLimits;
  /** Fallback bucket: Transaction Status, anything unspecialized. */
  default: ServiceLimits;
}

/**
 * Caller-facing input shape: any SUBSET of the service buckets. The
 * documented `Config({ limits: { b2c: { … } } })` example is this type —
 * requiring the full {@link TransactionLimits} on input would force callers
 * to spell out every bucket just to raise one ceiling.
 */
export type PartialTransactionLimits = { [K in LimitService]?: ServiceLimits };

/**
 * Service bucket keys. `"default"` is the fallback for endpoints without a
 * dedicated bucket (Transaction Status / anything unspecialized).
 */
export type LimitService = "stk" | "c2b" | "b2c" | "reversal" | "qr" | "default";

/**
 * Default ceilings. B2C carries the standard Safaricom default (250_000
 * per transaction, 500_000 per day); Safaricom-approved higher tiers are
 * raised explicitly via Config limits overrides. Reversal / Dynamic QR
 * carry the same numbers the shared `default` bucket historically applied
 * to them, so only explicit `default` overrides observe the split.
 */
export const DEFAULT_TRANSACTION_LIMITS: TransactionLimits = {
  stk: { maxPerTransaction: 250_000, maxPerDay: 500_000 },
  c2b: { maxPerTransaction: 250_000, maxPerDay: 500_000 },
  b2c: { maxPerTransaction: 250_000, maxPerDay: 500_000 },
  reversal: { maxPerTransaction: 250_000, maxPerDay: 500_000 },
  qr: { maxPerTransaction: 250_000, maxPerDay: 500_000 },
  default: { maxPerTransaction: 250_000, maxPerDay: 500_000 },
};

/** Human-readable service names for error messages. */
const SERVICE_LABELS: Record<LimitService, string> = {
  stk: "STK Push",
  c2b: "C2B",
  b2c: "B2C",
  reversal: "Reversal",
  qr: "Dynamic QR",
  default: "default",
};

/** Ordered service keys — drives the merge and the Config shape check. */
const SERVICE_KEYS: readonly LimitService[] = ["stk", "c2b", "b2c", "reversal", "qr", "default"];

/** Africa/Nairobi is UTC+3 year-round (no DST) — a fixed offset suffices. */
const NAIROBI_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * Normalize one ceiling: a finite number GREATER than zero is a ceiling;
 * everything else (`undefined`, `0`, negative, `NaN`, `Infinity`) is
 * UNLIMITED. Keeps partially-specified limits safe: an absent or bogus
 * ceiling can never silently tighten a merchant.
 *
 * @param value - Raw ceiling from config/defaults.
 * @returns The effective ceiling, or `undefined` for unlimited.
 */
export function effectiveCeiling(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

/**
 * Provenance marker for already-resolved limits objects.
 *
 * Why it exists (the "no third state" rule): in the RESOLVED shape an
 * omitted field means UNLIMITED, which is textually identical to an
 * unset field in a RAW input — and an unset field inherits the default.
 * Re-feeding a resolved object (e.g. `new Config({ limits: cfg.limits })`
 * when copying config, or any framework that re-wires config) would
 * therefore silently RE-TIGHTEN an UNLIMITED field back to the default.
 * Resolution must therefore be idempotent by identity: an object this
 * module already resolved is returned untouched.
 *
 * A WeakSet holds no strong reference, so nothing leaks; entries die with
 * the config object.
 */
const RESOLVED_LIMITS = new WeakSet<object>();

// The defaults are themselves a fully-resolved object: re-resolving them
// (or flowing them through a copied Config) must stay identity-stable.
RESOLVED_LIMITS.add(DEFAULT_TRANSACTION_LIMITS);

/**
 * Deep-merge a (possibly partial) limits object over
 * {@link DEFAULT_TRANSACTION_LIMITS}. Per-service, per-field: an omitted
 * field inherits the default field, and any explicit non-positive/non-finite
 * value becomes UNLIMITED. The merge is IDEMPOTENT — feeding an
 * already-resolved object (including {@link DEFAULT_TRANSACTION_LIMITS}
 * itself) returns it unchanged, so UNLIMITED fields survive config copies.
 *
 * Resolution semantics (identical across the three SDKs, no third state):
 * - field ABSENT from the input → the Safaricom default for that field;
 * - field PRESENT but `0`/negative/non-finite → UNLIMITED for that field
 *   ONLY; siblings and untouched services keep their defaults.
 *
 * @param partial - Caller-supplied limits (any subset), or an already
 *   resolved object (returned as-is).
 * @returns A fully-populated {@link TransactionLimits}.
 *
 * @example
 * ```ts
 * resolveTransactionLimits({ b2c: { maxPerTransaction: 700_000 } });
 * // b2c.maxPerTransaction = 700000, b2c.maxPerDay = 500000 (standard
 * // Safaricom default; approved-tier merchants raise via Config limits),
 * // stk/c2b/reversal/qr/default untouched.
 * ```
 */
export function resolveTransactionLimits(
  partial?: PartialTransactionLimits,
): TransactionLimits {
  // Idempotency by identity: anything already in RESOLVED_LIMITS is a
  // COMPLETE TransactionLimits (the marker is only ever added post-merge),
  // even though the parameter type accepts partials.
  if (partial !== undefined && RESOLVED_LIMITS.has(partial)) return partial as TransactionLimits;
  const merged = {} as Record<LimitService, ServiceLimits>;
  for (const key of SERVICE_KEYS) {
    const want = partial?.[key];
    const base = DEFAULT_TRANSACTION_LIMITS[key];
    // ABSENT field → default ceiling; PRESENT field → `effectiveCeiling`
    // (so an explicit 0/negative/non-finite UNLIMITED override is honored,
    // never silently re-tightened to the default).
    const perTxn = want?.maxPerTransaction === undefined
      ? base.maxPerTransaction
      : effectiveCeiling(want.maxPerTransaction);
    const perDay = want?.maxPerDay === undefined
      ? base.maxPerDay
      : effectiveCeiling(want.maxPerDay);
    merged[key] = {
      ...(perTxn !== undefined && { maxPerTransaction: perTxn }),
      ...(perDay !== undefined && { maxPerDay: perDay }),
    };
  }
  const resolved = merged as TransactionLimits;
  RESOLVED_LIMITS.add(resolved);
  return resolved;
}

/** The configured ceilings for one service bucket. */
export function limitsFor(limits: TransactionLimits, service: LimitService): ServiceLimits {
  return limits[service];
}

/**
 * Fail-fast per-transaction ceiling check. Called by the client AFTER the
 * existing minimum checks (which stay exactly as they were) and BEFORE any
 * network I/O, so an over-ceiling amount never reaches the gateway.
 *
 * @param service - Service bucket the amount is spent under.
 * @param amount - Whole-KES transaction amount.
 * @param limits - Effective (already merged) limits.
 * @throws {MpesaError} 400 when `amount` exceeds the configured
 *   `maxPerTransaction` ceiling. The message names the service, the
 *   ceiling, and the override path (`limits.<service>.maxPerTransaction`,
 *   `0` = unlimited).
 */
export function enforcePerTransactionLimit(
  service: LimitService,
  amount: number,
  limits: TransactionLimits,
): void {
  const ceiling = effectiveCeiling(limits[service]?.maxPerTransaction);
  if (ceiling === undefined) return; // unlimited
  if (!Number.isFinite(amount) || amount <= ceiling) return;
  throw new MpesaError(
    400,
    null,
    null,
    `${SERVICE_LABELS[service]} amount ${amount} exceeds the configured per-transaction limit of ${ceiling} KES ` +
      `(raise limits.${service}.maxPerTransaction in Config; 0 = unlimited)`,
  );
}

/**
 * Daily ceiling check (pure — the accumulator itself is the caller's).
 * Invoked only when daily tracking is enabled.
 *
 * @param service - Service bucket the amount is spent under.
 * @param amount - Whole-KES transaction amount about to be spent.
 * @param limits - Effective (already merged) limits.
 * @param usedToday - Whole-KES already accumulated for this service today.
 * @throws {MpesaError} 400 when `usedToday + amount` exceeds the
 *   configured `maxPerDay` ceiling. The message names the service, the
 *   running total, the ceiling, and the override path.
 */
export function checkDailyLimit(
  service: LimitService,
  amount: number,
  limits: TransactionLimits,
  usedToday: number,
): void {
  const ceiling = effectiveCeiling(limits[service]?.maxPerDay);
  if (ceiling === undefined) return; // unlimited
  if (!Number.isFinite(amount) || usedToday + amount <= ceiling) return;
  throw new MpesaError(
    400,
    null,
    null,
    `${SERVICE_LABELS[service]} daily limit reached: ${usedToday} KES already spent today, ` +
      `+ ${amount} KES would exceed the configured maxPerDay of ${ceiling} KES ` +
      `(raise limits.${service}.maxPerDay in Config; 0 = unlimited)`,
  );
}

/**
 * Africa/Nairobi civil-day key (`YYYY-MM-DD`) for an epoch timestamp.
 * Nairobi is UTC+3 with no DST, so the day is a fixed +3h shift of UTC —
 * implemented with plain arithmetic (no `Intl` timezone database, which
 * would make the boundary environment-dependent).
 *
 * @param nowMs - Epoch milliseconds (from the caller's injected clock).
 * @returns The Nairobi calendar day, e.g. `"2026-01-02"`.
 */
export function nairobiDayKey(nowMs: number): string {
  const shifted = new Date(nowMs + NAIROBI_UTC_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** All service keys, in catalog order (used by Config's shape check). */
export const LIMIT_SERVICE_KEYS: readonly LimitService[] = SERVICE_KEYS;
