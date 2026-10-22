/**
 * Tests for src/errors.ts — hostile-input safety and envelope parsing.
 *
 * Mirrors python/tests/test_exceptions.py (and the intent of go/errors_test.go):
 * the wire envelope parses cleanly, hostile bodies sanitize to single capped
 * lines, HTML pages yield a diagnostic, and fromResponse never throws on
 * garbage bytes.
 */
import { describe, expect, it } from "vitest";
import { MpesaDecodeError, MpesaError, decodeJsonObject, tryDecodeJsonObject } from "../src/errors.js";

const ENVELOPE =
  '{"requestId":"43169-3253970-1","errorCode":"500.001.1001",' +
  '"errorMessage":"[MerchantValidate] - Wrong credentials"}';

describe("MpesaError.fromResponse — envelope parsing", () => {
  it("parses the standard envelope and renders the go/py-parity message", () => {
    const err = MpesaError.fromResponse(500, ENVELOPE, "application/json");
    expect(err.statusCode).toBe(500);
    expect(err.requestId).toBe("43169-3253970-1");
    expect(err.errorCode).toBe("500.001.1001");
    expect(err.errorMessage).toBe("[MerchantValidate] - Wrong credentials");
    const rendered = err.message;
    expect(rendered.startsWith("mpesa: HTTP 500 ")).toBe(true);
    expect(rendered).toContain(
      "[MerchantValidate] - Wrong credentials [500.001.1001] requestId=43169-3253970-1",
    );
  });

  it("coerces numeric envelope fields to strings; other non-strings stay absent", () => {
    // Wire rule (go FlexString / py `_envelope_value` parity): a string or a
    // number is coerced; null, arrays and objects count as absent.
    const err = MpesaError.fromResponse(400, '{"requestId": 123, "errorCode": null}');
    expect(err.requestId).toBe("123");
    expect(err.errorCode).toBeNull();
    expect(err.errorMessage).toBeNull();
    expect(err.message).not.toContain("unexpected error response from gateway");
  });

  it("renders a BOOLEAN envelope member as its JSON text (go/py parity)", () => {
    // Go `FlexString` (go/coercion.go) falls through to the raw JSON text, so
    // `true` becomes "true"; Python `_envelope_value` does the same. A
    // boolean is a value the gateway SENT, not an absent member — dropping
    // it would lose the requestId the 401 retry probe keys on.
    const err = MpesaError.fromResponse(400, '{"requestId": true, "errorCode": false}');
    expect(err.requestId).toBe("true");
    expect(err.errorCode).toBe("false");
    expect(err.errorMessage).toBeNull();
    // A boolean member IS an envelope member, so the body is not treated as
    // a non-envelope diagnostic.
    expect(err.errorMessage).not.toBe("unexpected error response from gateway");
  });

  it("still counts an ARRAY or OBJECT member as absent while the others survive", () => {
    const err = MpesaError.fromResponse(400, '{"requestId": "rid-1", "errorCode": {"a": 1}}');
    expect(err.requestId).toBe("rid-1");
    expect(err.errorCode).toBeNull();
    expect(err.errorMessage).toBeNull();
  });
});

describe("MpesaError.fromResponse — hostile inputs", () => {
  it("sanitizes a hostile field to one line capped at exactly 512 chars", () => {
    const evil = "\x1b[31mred\x1b[0m\nsecond\x07line\u200b(zwsp)" + "A".repeat(600);
    const body = new TextEncoder().encode(JSON.stringify({ requestId: evil }));
    const err = MpesaError.fromResponse(400, body);
    expect(err.errorCode).toBeNull();
    expect(err.errorMessage).toBeNull();
    const rid = err.requestId;
    expect(rid).not.toBeNull();
    expect(rid!.length).toBe(512); // code-point cap, not UTF-16 units
    for (const forbidden of ["\x1b", "\n", "\r", "\x07", "\u200b"]) {
      expect(rid!).not.toContain(forbidden);
    }
  });

  it("HTML page yields the generic message and leaks NO part of the body", () => {
    const page = "<html><body>Request blocked by WAF</body></html>";
    const err = MpesaError.fromResponse(502, page, "text/html; charset=utf-8");
    expect(err.requestId).toBeNull();
    expect(err.errorCode).toBeNull();
    expect(err.errorMessage).toBe("unexpected error response from gateway");
    // The upstream body must not survive anywhere in the rendered message:
    // an exception object is logged by every logger on the call path.
    expect(err.message).not.toContain("Request blocked by WAF");
    expect(err.message).not.toContain("html");
    expect(err.message).toBe("mpesa: HTTP 502 unexpected error response from gateway");
  });
});

// ---------------------------------------------------------------------------
// Non-envelope body isolation (D7) — go `ErrorLogger` / py `error_logger`
// ---------------------------------------------------------------------------

describe("MpesaError.fromResponse — non-envelope body isolation", () => {
  const WAF_PAGE = "<html><body>WAF block page mentioning 254712345678</body></html>";

  it("hands the raw body to the opt-in sink with status and content type", () => {
    const seen: Array<{ status: number; contentType: string; body: string | Uint8Array }> = [];
    MpesaError.fromResponse(502, WAF_PAGE, "text/html", (status, contentType, body) => {
      seen.push({ status, contentType, body });
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.status).toBe(502);
    expect(seen[0]!.contentType).toBe("text/html");
    expect(seen[0]!.body).toBe(WAF_PAGE);
  });

  it("passes a binary body through to the sink untouched", () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x67, 0x61, 0x72, 0x62]);
    let seenBody: string | Uint8Array | undefined;
    MpesaError.fromResponse(400, bytes, "application/octet-stream", (_s, _c, body) => {
      seenBody = body;
    });
    expect(seenBody).toBe(bytes);
  });

  it("swallows a sink that throws — a broken sink must never mask the error", () => {
    const err = MpesaError.fromResponse(502, WAF_PAGE, "text/html", () => {
      throw new Error("sink exploded");
    });
    expect(err).toBeInstanceOf(MpesaError);
    expect(err.statusCode).toBe(502);
    expect(err.errorMessage).toBe("unexpected error response from gateway");
  });

  it("does NOT invoke the sink for a parseable envelope", () => {
    let called = false;
    const err = MpesaError.fromResponse(400, ENVELOPE, "application/json", () => {
      called = true;
    });
    expect(called).toBe(false);
    expect(err.errorCode).toBe("500.001.1001");
    expect(err.errorMessage).toBe("[MerchantValidate] - Wrong credentials");
  });

  it("invokes the sink exactly once, and only for the non-envelope branch", () => {
    let calls = 0;
    MpesaError.fromResponse(500, ENVELOPE, "application/json", () => { calls += 1; });
    expect(calls).toBe(0);
    MpesaError.fromResponse(500, '{"other": "field"}', "application/json", () => { calls += 1; });
    expect(calls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// A sink that REJECTS must not become an unhandled rejection.
//
// `ErrorLogger` is assignable from an `async` function, so a sink may return
// a promise. The try/catch around the sink call only catches a SYNCHRONOUS
// throw — a rejected promise used to escape as an unhandled rejection, which
// TERMINATES the Node process (Node >= 15). That broke the documented
// guarantee that a broken sink can never mask the gateway error.
// ---------------------------------------------------------------------------

describe("MpesaError.fromResponse — a rejecting sink is swallowed", () => {
  const WAF_PAGE = "<html><body>WAF block page mentioning 254712345678</body></html>";

  it("swallows a REJECTED sink promise: no unhandled rejection, same error", async () => {
    const rejections: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      let sinkCalls = 0;
      const err = MpesaError.fromResponse(502, WAF_PAGE, "text/html", async () => {
        sinkCalls += 1;
        throw new Error("sink exploded asynchronously");
      });
      expect(sinkCalls).toBe(1);

      // The caller still receives the generic gateway error — the sink's
      // failure never masks it.
      expect(err).toBeInstanceOf(MpesaError);
      expect(err.statusCode).toBe(502);
      expect(err.errorMessage).toBe("unexpected error response from gateway");
      expect(err.message).not.toContain("sink exploded");

      // Give the event loop a tick (and a second one): an unhandled
      // rejection is reported after the microtask queue drains, so a sink
      // that was NOT guarded would have fired the listener by now.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("still swallows a sink that throws SYNCHRONOUSLY", () => {
    const err = MpesaError.fromResponse(502, WAF_PAGE, "text/html", () => {
      throw new Error("sink exploded");
    });
    expect(err).toBeInstanceOf(MpesaError);
    expect(err.statusCode).toBe(502);
    expect(err.errorMessage).toBe("unexpected error response from gateway");
    expect(err.message).not.toContain("sink exploded");
  });

  it("swallows a sink that RESOLVES normally — the promise is not left dangling", async () => {
    let seen: string | undefined;
    const err = MpesaError.fromResponse(502, WAF_PAGE, "text/html", async () => {
      seen = "called";
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toBe("called");
    expect(err.errorMessage).toBe("unexpected error response from gateway");
  });
});

describe("MpesaError.fromResponse — never throws on garbage", () => {
  it("returns an MpesaError with a string message for every garbage shape", () => {
    const enc = new TextEncoder();
    const cases: Array<string | Uint8Array> = [
      "", // empty string body
      new Uint8Array(0), // empty byte body
      new Uint8Array([0xff, 0xfe, 0x00, 0x67, 0x61, 0x72, 0x62]), // invalid UTF-8
      enc.encode("{not json at all"),
      enc.encode("[1, 2, 3]"), // array top level
      enc.encode('"plain string"'), // scalar top level
      enc.encode('{"requestId": 123, "errorCode": null}'),
      enc.encode('\ufeff{"requestId":"bom-prefixed"}'), // BOM prefix (py parity)
      new Uint8Array(Array.from({ length: 256 }, (_, i) => i)), // all byte values
    ];
    cases.forEach((blob, i) => {
      const err = MpesaError.fromResponse(400 + i, blob);
      expect(err instanceof MpesaError).toBe(true);
      expect(err instanceof Error).toBe(true);
      expect(typeof err.message).toBe("string");
    });
  });

  it("BOM-prefixed JSON fails parsing like python, yielding the generic message", () => {
    const err = MpesaError.fromResponse(418, '\ufeff{"requestId":"bom-prefixed"}');
    expect(err.requestId).toBeNull();
    expect(err.errorMessage).toBe("unexpected error response from gateway");
  });
});

describe("MpesaError instance semantics", () => {
  it("hand-raised and factory instances satisfy the full prototype chain", () => {
    const raised = new MpesaError(404, "rid-1", "404.001.03", "gone");
    const parsed = MpesaError.fromResponse(500, ENVELOPE);
    for (const err of [raised, parsed]) {
      expect(err instanceof MpesaError).toBe(true);
      expect(Object.getPrototypeOf(err)).toBe(MpesaError.prototype);
      expect(err.name).toBe("MpesaError");
    }
    expect(raised.message).toBe("mpesa: HTTP 404 gone [404.001.03] requestId=rid-1");
  });

  it("omits empty segments from the rendered message", () => {
    expect(new MpesaError(429).message).toBe("mpesa: HTTP 429");
    expect(new MpesaError(429, null, "500.003.02").message).toBe("mpesa: HTTP 429 [500.003.02]");
  });
});

describe("sanitizer Unicode property escapes (Cc/Cf)", () => {
  it("strips Cf tag characters (U+E0020) and ZWSP while preserving emoji", () => {
    const body = JSON.stringify({ requestId: "ok\u{E0020}\u200B\u{1F389}" });
    const err = MpesaError.fromResponse(400, body);
    expect(err.requestId).toBe("ok\u{1F389}");
  });

  it("strips C0 controls and DEL but keeps printable ASCII", () => {
    const body = JSON.stringify({ errorCode: "A\x01\x7FB" });
    const err = MpesaError.fromResponse(400, body);
    expect(err.errorCode).toBe("AB");
  });
});


// ---------------------------------------------------------------------------
// MpesaDecodeError + the guarded decoders
// ---------------------------------------------------------------------------

describe("MpesaDecodeError", () => {
  it("is a MpesaError subclass (existing catch blocks keep working)", () => {
    const err = new MpesaDecodeError("mpesa: decode test body");
    expect(err).toBeInstanceOf(MpesaDecodeError);
    expect(err).toBeInstanceOf(MpesaError);
    expect(err.name).toBe("MpesaDecodeError");
    expect(err.statusCode).toBe(0);
  });

  it("enforces the mpesa: prefix", () => {
    expect(new MpesaDecodeError("decode failed").message).toBe("mpesa: decode failed");
    expect(new MpesaDecodeError("mpesa: already prefixed").message).toBe("mpesa: already prefixed");
  });

  it("carries the HTTP status when the body came from a response", () => {
    expect(new MpesaDecodeError("mpesa: x", 200).statusCode).toBe(200);
  });
});

describe("decodeJsonObject", () => {
  it("returns the decoded object", () => {
    expect(decodeJsonObject<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });

  it("rejects invalid JSON with a typed decode error", () => {
    expect(() => decodeJsonObject("<html>")).toThrow(MpesaDecodeError);
    expect(() => decodeJsonObject("")).toThrow(/invalid JSON/);
  });

  it("rejects non-object JSON (null/array/scalar) with a typed decode error", () => {
    expect(() => decodeJsonObject("null")).toThrow(/expected a JSON object, got null/);
    expect(() => decodeJsonObject("[]")).toThrow(/expected a JSON object, got array/);
    expect(() => decodeJsonObject("42")).toThrow(/expected a JSON object, got number/);
  });

  it("includes the label when provided", () => {
    expect(() => decodeJsonObject("", "/mpesa/stkpush/v1/processrequest")).toThrow(
      /decode \/mpesa\/stkpush\/v1\/processrequest body/,
    );
  });
});

describe("tryDecodeJsonObject", () => {
  it("never throws — null for anything that is not a plain object", () => {
    expect(tryDecodeJsonObject("<html>")).toBeNull();
    expect(tryDecodeJsonObject("null")).toBeNull();
    expect(tryDecodeJsonObject("[]")).toBeNull();
    expect(tryDecodeJsonObject('{"errorCode":"401.003.01"}')).toEqual({ errorCode: "401.003.01" });
  });
});