/**
 * Tests for src/limits.ts + the MpesaClient limits wiring — the
 * configurable per-merchant transaction-ceiling system (cross-language
 * parity spec).
 *
 * Covers: default ceilings per service, partial/undefined overrides,
 * UNLIMITED semantics (0), the fail-fast per-transaction gate BEFORE any
 * network I/O, the opt-in Africa/Nairobi daily accumulator (incl. the
 * midnight rollover and concurrent-caller atomicity), and the preserved
 * B2C minimum.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MpesaClient } from "../src/client.js";
import { Config, ConfigError, Environment } from "../src/config.js";
import { CommandID, QRTrxCode, TransactionType } from "../src/enums.js";
import { MpesaError } from "../src/errors.js";
import {
  DEFAULT_TRANSACTION_LIMITS,
  effectiveCeiling,
  nairobiDayKey,
  resolveTransactionLimits,
  type LimitService,
  type TransactionLimits,
} from "../src/limits.js";

const PASSKEY = "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";
const VALID_TOKEN_RESPONSE = { access_token: "tok-abc123", expires_in: "3599", token_type: "Bearer" };

// Africa/Nairobi is UTC+3 (no DST): Nairobi midnight = 21:00:00Z.
const NAIROBI_MIDNIGHT_MS = Date.UTC(2026, 0, 1, 21, 0, 0); // 2026-01-02 00:00 EAT
const DAY1_PRE_MIDNIGHT_MS = Date.UTC(2026, 0, 1, 20, 59, 0); // 2026-01-01 23:59 EAT
const DAY2_POST_MIDNIGHT_MS = Date.UTC(2026, 0, 1, 21, 0, 30); // 2026-01-02 00:00:30 EAT

let fetchMock: ReturnType<typeof vi.fn>;
let nowMs: number;
let businessHits: number;

beforeEach(() => {
  nowMs = DAY1_PRE_MIDNIGHT_MS;
  businessHits = 0;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** ACK shape per endpoint family (decode needs only a JSON object). */
function businessBodyFor(path: string): Record<string, unknown> {
  if (path === "/mpesa/stkpush/v1/processrequest") {
    return {
      MerchantRequestID: "mr-1",
      CheckoutRequestID: "ws_CO_1",
      ResponseCode: "0",
      ResponseDescription: "accepted",
      CustomerMessage: "ok",
    };
  }
  if (path === "/mpesa/qrcode/v1/generate") {
    return { ResponseCode: "00", RequestID: "r-1", ResponseDescription: "ok", QRCode: "qr" };
  }
  return { OriginatorConversationID: "o", ConversationID: "AG_1", ResponseCode: "0", ResponseDescription: "ok" };
}

/** Mock transport that counts DISPATCHED business calls. */
function mockTransport(): void {
  fetchMock.mockImplementation(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/oauth/v1/generate") return jsonResponse(VALID_TOKEN_RESPONSE);
    businessHits++;
    return jsonResponse(businessBodyFor(path));
  });
}

function makeClient(opts?: { limits?: TransactionLimits; trackDaily?: boolean }): MpesaClient {
  return new MpesaClient({
    config: new Config({
      consumerKey: "test-key",
      consumerSecret: "test-secret",
      shortcode: "174379",
      passkey: PASSKEY,
      environment: Environment.SANDBOX,
      ...(opts?.limits !== undefined && { limits: opts.limits }),
      ...(opts?.trackDaily !== undefined && { trackDaily: opts.trackDaily }),
    }),
    now: () => nowMs,
  });
}

function stkReq(amount: number) {
  return {
    transactionType: TransactionType.BillPayGoods,
    amount,
    partyA: "254722000000",
    phoneNumber: "254722111111",
    callBackURL: "https://mydomain.com/path",
    accountReference: "accountref",
    transactionDesc: "txndesc",
  };
}

function b2cReq(amount: number) {
  return {
    originatorConversationID: "a1b2c3d4e5f6a7b8",
    initiatorName: "testapi",
    securityCredential: "cred",
    commandID: CommandID.BusinessPayment,
    amount,
    partyA: "600992",
    partyB: "254705912645",
    remarks: "refund order 42",
    queueTimeOutURL: "https://mydomain.com/timeout",
    resultURL: "https://mydomain.com/result",
  };
}

function c2bSimReq(amount: number) {
  return {
    commandID: CommandID.PayBill,
    amount,
    msisdn: "0712345678",
    billRefNumber: "account-1",
  };
}

function reversalReq(amount: number) {
  return {
    initiator: "testapi",
    securityCredential: "cred",
    transactionID: "NLJ7RT61SV",
    amount,
    receiverParty: "600992",
    remarks: "wrong deposit",
    resultURL: "https://mydomain.com/result",
    queueTimeOutURL: "https://mydomain.com/timeout",
  };
}

function qrReq(amount: number) {
  return {
    merchantName: "TEST SUPERMARKET",
    refNo: "Invoice Test",
    amount,
    trxCode: QRTrxCode.BuyGoods,
    cpi: "174379",
    size: "300",
  };
}

// ---------------------------------------------------------------------------
// Defaults + merge semantics (pure)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CROSS-LANGUAGE PARITY MATRIX
//
// The case names below are SHARED VERBATIM with go/limits_fix_test.go and
// python/tests/test_limits.py — grep `<case name>` across the three repos
// to diff the implementations and prove parity. Each row is one explicit
// (input, expected decision) pair:
//   - `input`        : the raw `limits` object handed to resolveTransactionLimits
//   - `service`      : the bucket the probe amount is spent under
//   - `probe`        : the amount dispatched through a real client
//   - `expected`     : accept | reject (reject = typed 400, zero dispatches)
//   - `expectCeiling`: resolved maxPerTransaction for the probe service
//                      (null = UNLIMITED)
//   - `expectOther`  : extra resolved-object assertions for sibling fields
// The rule under test in all three SDKs: an UNSET field inherits the
// Safaricom default; an EXPLICIT 0 / negative / non-finite value means
// UNLIMITED for THAT FIELD ONLY; there is no third state, so a partial
// object can never silently disable a ceiling the developer did not touch.
// ---------------------------------------------------------------------------

interface ParityRow {
  readonly input: TransactionLimits | undefined;
  readonly service: LimitService;
  readonly probe: number;
  readonly expected: "accept" | "reject";
  readonly expectCeiling: number | null;
  readonly expectOther?: (limits: TransactionLimits) => void;
}

const PARITY_TABLE: ReadonlyArray<readonly [string, ParityRow]> = [
  [
    "undefined_limits_is_defaults",
    {
      input: undefined,
      service: "stk",
      probe: 250_000,
      expected: "accept",
      expectCeiling: 250_000,
      expectOther: (l) => {
        expect(l).toEqual(DEFAULT_TRANSACTION_LIMITS);
        expect(l.b2c.maxPerTransaction).toBe(250_000);
      },
    },
  ],
  [
    "partial_object_inherits_defaults",
    {
      input: {},
      service: "stk",
      probe: 250_000,
      expected: "accept",
      expectCeiling: 250_000,
    },
  ],
  [
    "partial_object_inherits_defaults__over_ceiling",
    {
      input: {},
      service: "stk",
      probe: 250_001,
      expected: "reject",
      expectCeiling: 250_000,
    },
  ],
  [
    "partial_object_raises_only_that_service",
    {
      input: { b2c: { maxPerTransaction: 700_000 } },
      service: "b2c",
      probe: 700_000,
      expected: "accept",
      expectCeiling: 700_000,
      expectOther: (l) => {
        // Only b2c moved — stk still enforces its default 250_000.
        expect(l.stk).toEqual(DEFAULT_TRANSACTION_LIMITS.stk);
        expect(l.b2c.maxPerDay).toBe(500_000);
      },
    },
  ],
  [
    "partial_object_raises_only_that_service__other_service_untouched",
    {
      input: { b2c: { maxPerTransaction: 700_000 } },
      service: "stk",
      probe: 300_000,
      expected: "reject",
      expectCeiling: 250_000,
    },
  ],
  [
    "explicit_zero_is_unlimited",
    {
      input: { stk: { maxPerTransaction: 0 } },
      service: "stk",
      probe: 9_999_999_999,
      expected: "accept",
      expectCeiling: null,
    },
  ],
  [
    "explicit_zero_disables_only_that_field",
    {
      input: { stk: { maxPerTransaction: 0 } },
      service: "stk",
      probe: 9_999_999_999,
      expected: "accept",
      expectCeiling: null,
      expectOther: (l) => {
        // The untouched sibling field keeps the Safaricom default.
        expect(l.stk.maxPerDay).toBe(500_000);
      },
    },
  ],
  [
    "explicit_unlimited_daily_with_default_per_txn",
    {
      input: { b2c: { maxPerDay: 0 } },
      service: "b2c",
      probe: 250_000,
      expected: "accept",
      expectCeiling: 250_000,
      expectOther: (l) => {
        // Daily is UNLIMITED, per-transaction still the standard default 250_000.
        expect(l.b2c.maxPerDay).toBeUndefined();
        expect(l.b2c.maxPerTransaction).toBe(250_000);
      },
    },
  ],
  [
    "explicit_unlimited_daily_with_default_per_txn__over_per_txn",
    {
      input: { b2c: { maxPerDay: 0 } },
      service: "b2c",
      probe: 250_001,
      expected: "reject",
      expectCeiling: 250_000,
    },
  ],
  [
    "negative_ceiling_is_unlimited",
    {
      input: { c2b: { maxPerTransaction: -1 } },
      service: "c2b",
      probe: 999_000_000,
      expected: "accept",
      expectCeiling: null,
    },
  ],
  [
    "non_finite_ceiling_is_unlimited",
    {
      input: { c2b: { maxPerTransaction: Number.NaN } },
      service: "c2b",
      probe: 123_456,
      expected: "accept",
      expectCeiling: null,
    },
  ],
  [
    "override_lowers_ceiling",
    {
      input: { default: { maxPerTransaction: 1_000 } },
      service: "default",
      probe: 1_001,
      expected: "reject",
      expectCeiling: 1_000,
    },
  ],
  [
    "b2c_default_is_250000",
    {
      input: undefined,
      service: "b2c",
      probe: 250_000,
      expected: "accept",
      expectCeiling: 250_000,
    },
  ],
  [
    "b2c_default_is_250000__over",
    {
      input: undefined,
      service: "b2c",
      probe: 250_001,
      expected: "reject",
      expectCeiling: 250_000,
    },
  ],
];

describe("CROSS-LANGUAGE PARITY MATRIX (shared with go/limits_fix_test.go and python/tests/test_limits.py)", () => {
  function dispatch(
    client: MpesaClient,
    service: LimitService,
    amount: number,
  ): Promise<unknown> {
    switch (service) {
      case "stk":
        return client.stkPush(stkReq(amount));
      case "c2b":
        return client.c2bSimulate(c2bSimReq(amount));
      case "b2c":
        return client.b2cPayout(b2cReq(amount));
      case "default":
        return client.reversal(reversalReq(amount));
    }
  }

  for (const [name, row] of PARITY_TABLE) {
    it(name, async () => {
      // (a) Resolution semantics: the resolved object is exactly the
      //     expected merge — ceiling value or UNLIMITED, siblings intact.
      const resolved = resolveTransactionLimits(row.input);
      const ceiling = effectiveCeiling(resolved[row.service].maxPerTransaction) ?? null;
      expect(ceiling, `resolved ceiling for ${name}`).toBe(row.expectCeiling);
      row.expectOther?.(resolved);

      // (b) Decision semantics: a real client accepts/rejects BEFORE any
      //     dispatch — a rejection never reaches the transport.
      mockTransport();
      const client = makeClient({ limits: row.input });
      const before = businessHits;
      if (row.expected === "accept") {
        await dispatch(client, row.service, row.probe);
        expect(businessHits, `${name} must dispatch`).toBe(before + 1);
      } else {
        await expect(dispatch(client, row.service, row.probe), name).rejects.toThrow(MpesaError);
        expect(businessHits, `${name} must not dispatch`).toBe(before);
      }
    });
  }

  it("resolution_is_idempotent__unlimited_survives_config_copy", () => {
    // A resolved object fed back in (e.g. `new Config({ limits: cfg.limits })`)
    // must NOT re-tighten UNLIMITED fields to the defaults.
    const once = resolveTransactionLimits({ stk: { maxPerTransaction: 0 } });
    const twice = resolveTransactionLimits(once);
    expect(twice).toBe(once); // identity-stable
    expect(twice.stk.maxPerTransaction).toBeUndefined();
    expect(resolveTransactionLimits(DEFAULT_TRANSACTION_LIMITS)).toBe(DEFAULT_TRANSACTION_LIMITS);

    // And the copied config keeps the UNLIMITED behaviour end-to-end.
    mockTransport();
    const cfg = new Config({
      consumerKey: "k", consumerSecret: "s", shortcode: "174379", passkey: PASSKEY,
      limits: { stk: { maxPerTransaction: 0 } },
    });
    const copied = new Config({ ...cfgOpts(cfg), limits: cfg.limits });
    const client = new MpesaClient({ config: copied, now: () => nowMs });
    expect(client).toBeInstanceOf(MpesaClient);
  });

  it("resolution_happens_once_at_config_construction__no_per_request_drift", () => {
    // The client consumes the object Config resolved at construction: two
    // sequential calls with a mutated raw input cannot change the ceiling.
    const raw: TransactionLimits = { stk: { maxPerTransaction: 100 } };
    const client = makeClient({ limits: raw });
    (raw.stk as { maxPerTransaction: number }).maxPerTransaction = 999_999;
    mockTransport();
    // 101 > the 100 captured at construction → still rejected (no drift).
    return expect(client.stkPush(stkReq(101))).rejects.toThrow(/per-transaction limit of 100/);
  });
});

/** Config-shaped options for the copy test above. */
function cfgOpts(cfg: Config) {
  return {
    consumerKey: cfg.consumerKey,
    consumerSecret: cfg.consumerSecret,
    shortcode: cfg.shortcode,
    passkey: cfg.passkey,
    environment: cfg.environment,
  };
}

describe("limit defaults and merge semantics", () => {
  it("DEFAULT_TRANSACTION_LIMITS matches the cross-language spec", () => {
    expect(DEFAULT_TRANSACTION_LIMITS).toEqual({
      stk: { maxPerTransaction: 250_000, maxPerDay: 500_000 },
      c2b: { maxPerTransaction: 250_000, maxPerDay: 500_000 },
      b2c: { maxPerTransaction: 250_000, maxPerDay: 500_000 },
      default: { maxPerTransaction: 250_000, maxPerDay: 500_000 },
    });
  });

  it("omitted limits resolve to the defaults", () => {
    expect(resolveTransactionLimits()).toEqual(DEFAULT_TRANSACTION_LIMITS);
    expect(resolveTransactionLimits({})).toEqual(DEFAULT_TRANSACTION_LIMITS);
  });

  it("a partial override merges per-field; other fields keep defaults", () => {
    const merged = resolveTransactionLimits({ b2c: { maxPerTransaction: 700_000 } });
    expect(merged.b2c).toEqual({ maxPerTransaction: 700_000, maxPerDay: 500_000 });
    expect(merged.stk).toEqual(DEFAULT_TRANSACTION_LIMITS.stk);
    expect(merged.c2b).toEqual(DEFAULT_TRANSACTION_LIMITS.c2b);
    expect(merged.default).toEqual(DEFAULT_TRANSACTION_LIMITS.default);
  });

  it("an explicit 0 / negative ceiling means UNLIMITED (not the default)", () => {
    const merged = resolveTransactionLimits({
      stk: { maxPerTransaction: 0, maxPerDay: -5 },
    });
    expect(merged.stk.maxPerTransaction).toBeUndefined();
    expect(merged.stk.maxPerDay).toBeUndefined();
  });

  it("non-finite ceilings normalize to UNLIMITED", () => {
    const merged = resolveTransactionLimits({ c2b: { maxPerTransaction: Number.NaN } });
    expect(merged.c2b.maxPerTransaction).toBeUndefined();
  });

  it("Config carries the normalized merge and defaults trackDaily to false", () => {
    const cfg = new Config({ consumerKey: "k", consumerSecret: "s", shortcode: "174379", passkey: "p" });
    expect(cfg.limits).toEqual(DEFAULT_TRANSACTION_LIMITS);
    expect(cfg.trackDaily).toBe(false);

    const upgraded = new Config({
      consumerKey: "k", consumerSecret: "s", shortcode: "174379", passkey: "p",
      limits: { stk: { maxPerTransaction: 0 } },
      trackDaily: true,
    });
    expect(upgraded.limits.stk.maxPerTransaction).toBeUndefined();
    expect(upgraded.trackDaily).toBe(true);
  });

  it("Config rejects a non-numeric ceiling loudly (ConfigError)", () => {
    expect(() =>
      new Config({
        consumerKey: "k", consumerSecret: "s", shortcode: "174379", passkey: "p",
        limits: { stk: { maxPerTransaction: "lots" as unknown as number } },
      }),
    ).toThrow(ConfigError);
  });
});

// ---------------------------------------------------------------------------
// nairobiDayKey — the UTC+3 (no DST) day boundary
// ---------------------------------------------------------------------------

describe("nairobiDayKey", () => {
  it("shifts epoch ms by +3h before taking the UTC date", () => {
    expect(nairobiDayKey(Date.UTC(2026, 0, 1, 20, 59, 59))).toBe("2026-01-01");
    expect(nairobiDayKey(Date.UTC(2026, 0, 1, 21, 0, 0))).toBe("2026-01-02");
  });

  it("has no DST discontinuity (fixed offset year-round)", () => {
    // July (northern DST) and January must behave identically.
    expect(nairobiDayKey(Date.UTC(2026, 6, 15, 12, 0, 0))).toBe("2026-07-15");
    expect(nairobiDayKey(Date.UTC(2026, 0, 15, 12, 0, 0))).toBe("2026-01-15");
  });
});

// ---------------------------------------------------------------------------
// Per-transaction enforcement (fail fast, before dispatch)
// ---------------------------------------------------------------------------

describe("per-transaction limits", () => {
  beforeEach(mockTransport);

  it("B2C and STK share the standard 250000 default ceiling", async () => {
    const client = makeClient();

    await client.b2cPayout(b2cReq(250_000));
    await client.stkPush(stkReq(250_000));
    expect(businessHits).toBe(2);

    await expect(client.stkPush(stkReq(300_000))).rejects.toThrow(MpesaError);
    await expect(client.b2cPayout(b2cReq(300_000))).rejects.toThrow(MpesaError);
    expect(businessHits).toBe(2);

    // Approved-tier merchants raise via Config limits override.
    const upgraded = makeClient({ limits: { b2c: { maxPerTransaction: 500_000 } } });
    await upgraded.b2cPayout(b2cReq(300_000));
    expect(businessHits).toBe(3);
  });

  it("each service enforces its own default ceiling", async () => {
    const client = makeClient();
    await client.stkPush(stkReq(250_000)); // STK ceiling
    await client.c2bSimulate(c2bSimReq(250_000)); // C2B ceiling
    await client.b2cPayout(b2cReq(250_000)); // B2C ceiling (standard Safaricom default)
    expect(businessHits).toBe(3);

    await expect(client.stkPush(stkReq(250_001))).rejects.toThrow(/per-transaction limit of 250000/);
    await expect(client.c2bSimulate(c2bSimReq(250_001))).rejects.toThrow(/per-transaction limit of 250000/);
    await expect(client.b2cPayout(b2cReq(250_001))).rejects.toThrow(/per-transaction limit of 250000/);
    // Fail-fast: no extra dispatch for the three rejections.
    expect(businessHits).toBe(3);

    // Approved-tier merchants raise via Config limits override.
    const upgraded = makeClient({ limits: { b2c: { maxPerTransaction: 500_000 } } });
    await upgraded.b2cPayout(b2cReq(500_000));
    expect(businessHits).toBe(4);
  });

  it("the error names the service, the ceiling, and the override path", async () => {
    const client = makeClient();
    let caught: unknown;
    try {
      await client.stkPush(stkReq(300_000));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MpesaError);
    const err = caught as MpesaError;
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain("STK Push amount 300000");
    expect(err.message).toContain("per-transaction limit of 250000 KES");
    expect(err.message).toContain("limits.stk.maxPerTransaction");
    expect(err.message).toContain("0 = unlimited");
  });

  it("an override RAISES a ceiling (upgraded merchant, no SDK upgrade)", async () => {
    const client = makeClient({ limits: { stk: { maxPerTransaction: 400_000 } } });
    await client.stkPush(stkReq(400_000));
    expect(businessHits).toBe(1);
    await expect(client.stkPush(stkReq(400_001))).rejects.toThrow(/per-transaction limit of 400000/);
  });

  it("an override LOWERS a ceiling", async () => {
    const client = makeClient({ limits: { b2c: { maxPerTransaction: 100 } } });
    await client.b2cPayout(b2cReq(100));
    await expect(client.b2cPayout(b2cReq(101))).rejects.toThrow(/per-transaction limit of 100/);
  });

  it("0 (UNLIMITED) disables the per-transaction ceiling", async () => {
    const client = makeClient({ limits: { stk: { maxPerTransaction: 0 } } });
    await client.stkPush(stkReq(5_000_000));
    expect(businessHits).toBe(1);
  });

  it("the `default` bucket gates Reversal and Dynamic QR", async () => {
    const client = makeClient({ limits: { default: { maxPerTransaction: 1_000 } } });
    await expect(client.reversal(reversalReq(2_000))).rejects.toThrow(/per-transaction limit of 1000/);
    await expect(client.generateQRCode(qrReq(2_000))).rejects.toThrow(/per-transaction limit of 1000/);
    await client.reversal(reversalReq(1_000));
    await client.generateQRCode(qrReq(1_000));
    expect(businessHits).toBe(2);
  });

  it("keeps the B2C >= 10 minimum exactly as before", async () => {
    const client = makeClient();
    await expect(client.b2cPayout(b2cReq(9))).rejects.toThrow(
      "mpesa: B2C Amount must be a whole number of at least 10, got 9",
    );
    expect(businessHits).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Daily accumulation (opt-in)
// ---------------------------------------------------------------------------

describe("daily limits (trackDaily)", () => {
  beforeEach(mockTransport);

  it("is OFF by default — no daily gate, no accumulator", async () => {
    // Even with a tiny maxPerDay, the default client never checks it.
    const client = makeClient({ limits: { stk: { maxPerDay: 1 } } });
    await client.stkPush(stkReq(100_000));
    await client.stkPush(stkReq(100_000));
    expect(businessHits).toBe(2);
  });

  it("enforces maxPerDay once enabled, without sending the request", async () => {
    const client = makeClient({ limits: { stk: { maxPerTransaction: 0, maxPerDay: 500_000 } }, trackDaily: true });
    await client.stkPush(stkReq(300_000)); // 300_000 used
    expect(businessHits).toBe(1);

    let caught: unknown;
    try {
      await client.stkPush(stkReq(300_000)); // would total 600_000
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MpesaError);
    const err = caught as MpesaError;
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain("STK Push daily limit reached");
    expect(err.message).toContain("300000 KES already spent today");
    expect(err.message).toContain("maxPerDay of 500000 KES");
    expect(err.message).toContain("limits.stk.maxPerDay");
    expect(businessHits).toBe(1); // fail-fast: never dispatched
  });

  it("rolls the accumulator over at Africa/Nairobi midnight", async () => {
    const client = makeClient({ limits: { stk: { maxPerTransaction: 0, maxPerDay: 300_000 } }, trackDaily: true });

    nowMs = DAY1_PRE_MIDNIGHT_MS; // 2026-01-01 23:59 EAT
    await client.stkPush(stkReq(300_000));
    await expect(client.stkPush(stkReq(1))).rejects.toThrow(/daily limit reached/);

    // One minute later the clock crosses Nairobi midnight — a fresh day.
    nowMs = DAY2_POST_MIDNIGHT_MS; // 2026-01-02 00:00:30 EAT
    await client.stkPush(stkReq(300_000));
    expect(businessHits).toBe(2);
  });

  it("concurrent async callers accumulate exactly once each", async () => {
    const client = makeClient({
      limits: { stk: { maxPerTransaction: 0, maxPerDay: 400_000 } }, // only the daily gate bites
      trackDaily: true,
    });

    // 8 concurrent 100_000 pushes: the first 4 fit (4 — 100_000 = the cap),
    // the rest must be rejected — proving each gate counted exactly once.
    const calls = Array.from({ length: 8 }, () => client.stkPush(stkReq(100_000)));
    const results = await Promise.allSettled(calls);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(4);
    expect(rejected).toHaveLength(4);
    expect(businessHits).toBe(4);
  });

  it("keeps daily buckets per service (B2C and STK do not share a budget)", async () => {
    const client = makeClient({
      // maxPerDay 500_000 is the standard default (identity override, kept
      // explicit to pin the merge); maxPerTransaction 500_000 is an
      // approved-tier override so the 500_000 probe clears the per-txn gate.
      limits: { b2c: { maxPerTransaction: 500_000, maxPerDay: 500_000 } },
      trackDaily: true,
    });
    // B2C budget 500_000/day: fill it, then prove the STK bucket is untouched.
    await client.b2cPayout(b2cReq(500_000));
    await expect(client.b2cPayout(b2cReq(10))).rejects.toThrow(/B2C daily limit reached/);
    await client.stkPush(stkReq(250_000));
    expect(businessHits).toBe(2);
  });
});
