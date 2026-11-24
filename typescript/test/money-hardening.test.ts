/**
 * Money-handling hardening (M1 / M2 / M5 / M9) — TypeScript engine.
 *
 * These tests pin the money-safety contract that the cross-language review
 * found missing:
 *  - request amounts must be SAFE integers inside a hard whole-KES bound,
 *    and must be refused BEFORE any fetch (never serialized as `1e+21`);
 *  - inbound amounts must be strictly positive (no zero / negative money);
 *  - the callback / async-result verification helpers must refuse to settle
 *    when the amount is absent, hostile, duplicated, or simply different
 *    from the amount stored on the caller's order;
 *  - configured ceilings must be representable amounts (finite positive
 *    safe integers, or 0 = unlimited), and the daily ledger comparison must
 *    saturate rather than rely on a lossy `used + amount` sum.
 *
 * Every expectation is a hand-derived literal; nothing is computed by the
 * code under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MpesaClient } from "../src/client.js";
import { Config, ConfigError, Environment } from "../src/config.js";
import { coerceAmount } from "../src/coercion.js";
import { parseSTKCallback } from "../src/callbacks.js";
import { parseAsyncResultBody } from "../src/types.js";
import { checkDailyLimit, isValidCeiling } from "../src/limits.js";
import { CommandID, TransactionType } from "../src/enums.js";
import { MpesaError } from "../src/errors.js";

const PASSKEY = "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";
const TOKEN_RESPONSE = { access_token: "tok-money", expires_in: "3599", token_type: "Bearer" };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
let businessHits: number;

beforeEach(() => {
  businessHits = 0;
  fetchMock = vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/oauth/v1/generate") return jsonResponse(TOKEN_RESPONSE);
    businessHits++;
    return jsonResponse({
      MerchantRequestID: "m-1",
      CheckoutRequestID: "ws_CO_1",
      ResponseCode: "0",
      ResponseDescription: "accepted",
      CustomerMessage: "ok",
    });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function makeClient(limits?: { stk: { maxPerTransaction: number } }): MpesaClient {
  return new MpesaClient({
    config: new Config({
      consumerKey: "test-key",
      consumerSecret: "test-secret",
      shortcode: "174379",
      passkey: PASSKEY,
      environment: Environment.SANDBOX,
      ...(limits !== undefined && { limits }),
    }),
    now: () => Date.UTC(2026, 0, 1, 12, 0, 0),
  });
}

function stkReq(amount: number) {
  return {
    transactionType: TransactionType.BillPayGoods,
    amount,
    partyA: "254722000000",
    phoneNumber: "254722111111",
    callBackURL: "https://mydomain.com/callback",
    accountReference: "order-42",
    transactionDesc: "payment",
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

/** Callback envelope with one metadata item named `Amount`. */
function callbackWithAmount(valueText: string): string {
  return (
    '{"Body":{"stkCallback":{"MerchantRequestID":"m","CheckoutRequestID":"c",' +
    '"ResultCode":0,"ResultDesc":"ok","CallbackMetadata":{"Item":[' +
    '{"Name":"Amount","Value":' + valueText + '}' +
    ']}}}}'
  );
}

// ─── M1: request amount gates ────────────────────────────────────────────────

describe("request amount gates refuse unsafe / out-of-range numbers before fetch", () => {
  const unsafe = [2 ** 53, 1e21, Number.MAX_VALUE] as const;

  for (const bad of unsafe) {
    it(`stkPush rejects ${String(bad)} before any fetch`, async () => {
      const client = makeClient();
      await expect(client.stkPush(stkReq(bad))).rejects.toThrow(/positive whole number/);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(businessHits).toBe(0);
    });
  }

  it("rejects an exactly-representable amount past the 1e12 whole-KES bound", async () => {
    // Ceiling is deliberately raised so ONLY the hard bound can reject.
    const client = makeClient({ stk: { maxPerTransaction: 2_000_000_000_000 } });
    await expect(client.stkPush(stkReq(1_000_000_000_001))).rejects.toThrow(
      /positive whole number/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts the boundary amount 250000 and dispatches it as plain decimal", async () => {
    const client = makeClient();
    await expect(client.stkPush(stkReq(250_000))).resolves.toBeDefined();
    expect(businessHits).toBe(1);
    const sentBody = fetchMock.mock.calls.find(
      (call: unknown[]) => new URL(String(call[0])).pathname === "/mpesa/stkpush/v1/processrequest",
    )?.[1] as { body?: string } | undefined;
    expect(sentBody?.body).toContain('"Amount":250000');
    expect(sentBody?.body).not.toMatch(/"Amount":\s*[\d.]+e/i);
  });

  it("accepts the hard ceiling amount 1e12 when the configured ceiling allows it", async () => {
    const client = makeClient({ stk: { maxPerTransaction: 1_000_000_000_000 } });
    await expect(client.stkPush(stkReq(1_000_000_000_000))).resolves.toBeDefined();
    expect(businessHits).toBe(1);
  });

  it("the B2C min gate also refuses unsafe amounts before any fetch", async () => {
    const client = makeClient();
    await expect(client.b2cPayout(b2cReq(2 ** 53))).rejects.toThrow(Error);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── M2: inbound amount verification ─────────────────────────────────────────

describe("StkCallback.amountMatches gates settlement on the stored amount", () => {
  it("returns true when the callback amount equals the expected amount", () => {
    expect(parseSTKCallback(callbackWithAmount("100")).amountMatches(100)).toBe(true);
  });

  it("returns false on a mismatch", () => {
    expect(parseSTKCallback(callbackWithAmount("100")).amountMatches(999)).toBe(false);
  });

  it("returns false when Amount is absent", () => {
    const raw =
      '{"Body":{"stkCallback":{"MerchantRequestID":"m","CheckoutRequestID":"c",' +
      '"ResultCode":1037,"ResultDesc":"DS timeout"}}}';
    expect(parseSTKCallback(raw).amountMatches(100)).toBe(false);
  });

  it("returns false when Amount is hostile (boolean)", () => {
    expect(parseSTKCallback(callbackWithAmount("true")).amountMatches(1)).toBe(false);
  });

  it("returns false when Amount metadata is duplicated, even though first-wins matches", () => {
    const raw =
      '{"Body":{"stkCallback":{"MerchantRequestID":"m","CheckoutRequestID":"c",' +
      '"ResultCode":0,"ResultDesc":"ok","CallbackMetadata":{"Item":[' +
      '{"Name":"Amount","Value":100},{"Name":"Amount","Value":999}' +
      ']}}}}';
    const cb = parseSTKCallback(raw);
    expect(cb.amount()).toBe(100);
    expect(cb.duplicateKeys()).toBe(1);
    expect(cb.amountMatches(100)).toBe(false);
  });

  it("returns false for an unusable `expected` (negative, fractional, unsafe)", () => {
    const cb = parseSTKCallback(callbackWithAmount("100"));
    expect(cb.amountMatches(-100)).toBe(false);
    expect(cb.amountMatches(0)).toBe(false);
    expect(cb.amountMatches(10.5)).toBe(false);
    expect(cb.amountMatches(Number.MAX_VALUE)).toBe(false);
    expect(cb.amountMatches(2 ** 53)).toBe(false);
  });
});

describe("ParsedAsyncResult.amountMatches mirrors the callback helper", () => {
  const asyncBody = (valueText: string) =>
    JSON.stringify({
      Result: {
        ResultCode: "0",
        ResultDesc: "ok",
        ResultParameters: {
          ResultParameter: [{ Key: "TransactionAmount", Value: valueText }],
        },
      },
    });

  it("returns true on a match and false on a mismatch", () => {
    expect(parseAsyncResultBody(asyncBody("250000")).amountMatches(250_000)).toBe(true);
    expect(parseAsyncResultBody(asyncBody("250000")).amountMatches(250)).toBe(false);
  });

  it("returns false on duplicated TransactionAmount metadata", () => {
    const body = JSON.stringify({
      Result: {
        ResultCode: "0",
        ResultDesc: "ok",
        ResultParameters: {
          ResultParameter: [
            { Key: "TransactionAmount", Value: 250000 },
            { Key: "TransactionAmount", Value: 999 },
          ],
        },
      },
    });
    const result = parseAsyncResultBody(body);
    expect(result.duplicateKeys()).toBe(1);
    expect(result.amountMatches(250_000)).toBe(false);
  });
});

// ─── M5: strict positive inbound amounts ─────────────────────────────────────

describe("coerceAmount refuses zero and negative money", () => {
  it("returns null for negative strings and numbers", () => {
    expect(coerceAmount("-500000")).toBeNull();
    expect(coerceAmount(-500_000)).toBeNull();
    expect(coerceAmount("-0.01")).toBeNull();
  });

  it("returns null for zero in every spelling", () => {
    expect(coerceAmount(0)).toBeNull();
    expect(coerceAmount(-0)).toBeNull();
    expect(coerceAmount("0")).toBeNull();
    expect(coerceAmount("0.00")).toBeNull();
  });

  it("still accepts canonical positive amounts", () => {
    expect(coerceAmount("10.50")).toBe(10.5);
    expect(coerceAmount(250_000)).toBe(250_000);
  });
});

// ─── M9: configured ceilings + saturating ledger comparison ──────────────────

describe("isValidCeiling accepts only representable configured ceilings", () => {
  it("accepts absent (default), zero (unlimited), and positive safe integers", () => {
    expect(isValidCeiling(undefined)).toBe(true);
    expect(isValidCeiling(0)).toBe(true);
    expect(isValidCeiling(250_000)).toBe(true);
    expect(isValidCeiling(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("rejects fractions, negatives, non-finite values, and unsafe integers", () => {
    expect(isValidCeiling(250_000.5)).toBe(false);
    expect(isValidCeiling(-1)).toBe(false);
    expect(isValidCeiling(Number.NaN)).toBe(false);
    expect(isValidCeiling(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidCeiling(2 ** 53)).toBe(false);
  });

  it("Config rejects a fractional ceiling before any client is built", () => {
    expect(
      () =>
        new Config({
          consumerKey: "k",
          consumerSecret: "s",
          shortcode: "174379",
          passkey: PASSKEY,
          limits: { stk: { maxPerTransaction: 250_000.5 } },
        }),
    ).toThrow(ConfigError);
  });
});

describe("checkDailyLimit uses saturating subtraction", () => {
  it("refuses a sub-ULP increment at MAX_SAFE_INTEGER that naive addition rounds away", () => {
    // Built directly so the pure helper is tested (no client / ceiling gate).
    const resolved = {
      stk: { maxPerDay: Number.MAX_SAFE_INTEGER },
    } as Parameters<typeof checkDailyLimit>[2];
    expect(
      () => checkDailyLimit("stk", 0.1, resolved, Number.MAX_SAFE_INTEGER),
    ).toThrow(MpesaError);
  });

  it("allows an amount that exactly fills the remaining budget", () => {
    const resolved = { stk: { maxPerDay: 500_000 } } as Parameters<typeof checkDailyLimit>[2];
    expect(() => checkDailyLimit("stk", 100, resolved, 499_900)).not.toThrow();
    expect(() => checkDailyLimit("stk", 101, resolved, 499_900)).toThrow(MpesaError);
  });
});
