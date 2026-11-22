/**
 * Phase-3 core audit pins — cross-language parity and fail-closed hardening
 * for the TypeScript SDK engine. Each describe block locks one confirmed fix
 * so a later refactor cannot silently restore the audited behavior.
 */
import { describe, expect, it } from "vitest";
import { readBodyBounded } from "../src/_bounded-read.js";
import { callbackTokenEqual, newCallbackToken } from "../src/callback-token.js";
import { classifyResultCode, ResultClass } from "../src/classification.js";
import {
  coerceAmount,
  coerceInt,
  coerceOpaqueWireString,
  safeJsonInt,
} from "../src/coercion.js";
import { MpesaError } from "../src/errors.js";
import {
  DEFAULT_TRANSACTION_LIMITS,
  LIMIT_SERVICE_KEYS,
  resolveTransactionLimits,
} from "../src/limits.js";

describe("phase-3 audit: gateway error log-line forgery", () => {
  it("strips U+2028 (Zl) and U+2029 (Zp) from fields and the rendered message", () => {
    const body = JSON.stringify({
      requestId: "rid\u2028forged",
      errorCode: "500.001.1001",
      errorMessage: "bad\u2029injected\u2028line",
    });
    const err = MpesaError.fromResponse(500, body);

    expect(err.requestId).toBe("ridforged");
    expect(err.errorCode).toBe("500.001.1001");
    expect(err.errorMessage).toBe("badinjectedline");
    expect(err.message).toBe(
      "mpesa: HTTP 500 badinjectedline [500.001.1001] requestId=ridforged",
    );
    expect(err.message).not.toMatch(/[\u2028\u2029]/);
  });
});

describe("phase-3 audit: callback token fails closed on non-strings", () => {
  it("returns false rather than coercing a route/query value before the guard", () => {
    expect(callbackTokenEqual(5 as unknown as string, "abc")).toBe(false);
    expect(callbackTokenEqual("abc", 5 as unknown as string)).toBe(false);
    expect(callbackTokenEqual(undefined as unknown as string, "abc")).toBe(false);
    expect(callbackTokenEqual(null as unknown as string, null as unknown as string)).toBe(false);
  });

  it("keeps constant-time exact comparison for real tokens", () => {
    const token = newCallbackToken();
    expect(callbackTokenEqual(token, token)).toBe(true);
    expect(callbackTokenEqual(token, `${token}x`)).toBe(false);
  });
});

describe("phase-3 audit: coercion parity with Go/Python", () => {
  it("coerceAmount applies the 2dp shape gate to numbers too", () => {
    expect(coerceAmount(1.123456)).toBeNull(); // sub-cent noise refused
    expect(coerceAmount(1e21)).toBeNull(); // exponent form refused
    expect(coerceAmount("10.50")).toBe(10.5);
    expect(coerceAmount(10.5)).toBe(10.5);
  });

  it("coerceInt accepts 2147483647 (INT32_MAX is a legitimate value)", () => {
    expect(coerceInt(2147483647)).toBe(2147483647);
  });

  it("safeJsonInt uses signed ASCII integer grammar, not JSON.parse", () => {
    expect(safeJsonInt("1e3")).toBeNull();
    expect(safeJsonInt("+100")).toBe(100);
  });

  it("coerceOpaqueWireString never truncates and rejects non-scalars", () => {
    const long = "x".repeat(5000);
    expect(coerceOpaqueWireString(`  ${long}  `)).toBe(long);
    expect(coerceOpaqueWireString({ a: 1 })).toBeNull();
    expect(coerceOpaqueWireString([1, 2])).toBeNull();
    expect(coerceOpaqueWireString(123)).toBe("123");
    expect(coerceOpaqueWireString(null)).toBeNull();
  });
});

describe("phase-3 audit: process-wide default limits are immutable", () => {
  it("deep-freezes the root and all nine ServiceLimits", () => {
    expect(Object.isFrozen(DEFAULT_TRANSACTION_LIMITS)).toBe(true);
    for (const key of LIMIT_SERVICE_KEYS) {
      expect(Object.isFrozen(DEFAULT_TRANSACTION_LIMITS[key])).toBe(true);
    }
  });

  it("resolveTransactionLimits still merges over the frozen defaults", () => {
    const resolved = resolveTransactionLimits({ b2c: { maxPerTransaction: 700_000 } });
    expect(resolved.b2c.maxPerTransaction).toBe(700_000);
    expect(resolved.b2c.maxPerDay).toBe(500_000);
    expect(resolved.stk.maxPerTransaction).toBe(250_000);
  });
});

describe("phase-3 audit: over-cap body keeps typed 413 when cancel() rejects", () => {
  it("rejects with MpesaError HTTP 413 instead of the cancel() error", async () => {
    const reader = {
      read: async (): Promise<{ done: boolean; value?: Uint8Array }> => ({
        done: false,
        value: new Uint8Array(200),
      }),
      cancel: async (): Promise<void> => {
        throw new Error("cancel failed");
      },
      releaseLock: (): void => {},
    };
    const body = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;

    let caught: unknown;
    try {
      await readBodyBounded(body, "/audit", 100);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(MpesaError);
    expect((caught as MpesaError).statusCode).toBe(413);
    expect((caught as MpesaError).message).toContain("exceeds 100 bytes");
  });
});

describe("phase-3 audit: ResultClass canonical name and deprecated alias", () => {
  it("exposes INDETERMINATE and INCONCLUSIVE with the same wire value", () => {
    expect(ResultClass.INDETERMINATE).toBe("indeterminate");
    expect(ResultClass.INCONCLUSIVE).toBe(ResultClass.INDETERMINATE);
    expect(classifyResultCode("??")).toBe(ResultClass.INDETERMINATE);
    expect(classifyResultCode("??")).toBe(ResultClass.INCONCLUSIVE);
  });
});
