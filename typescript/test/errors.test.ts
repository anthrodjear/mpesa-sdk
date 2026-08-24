/**
 * Tests for src/errors.ts — hostile-input safety and envelope parsing.
 *
 * Mirrors python/tests/test_exceptions.py (and the intent of go/errors_test.go):
 * the wire envelope parses cleanly, hostile bodies sanitize to single capped
 * lines, HTML pages yield a diagnostic, and fromResponse never throws on
 * garbage bytes.
 */
import { describe, expect, it } from "vitest";
import { MpesaError } from "../src/errors.js";

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
    // Documented TS-spec rule: string|number accepted (number -> String()).
    const err = MpesaError.fromResponse(400, '{"requestId": 123, "errorCode": null}');
    expect(err.requestId).toBe("123");
    expect(err.errorCode).toBeNull();
    expect(err.errorMessage).toBeNull();
    expect(err.message).not.toContain("unparseable");
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

  it("HTML page yields a diagnostic carrying contentType, byte length and snippet", () => {
    const page = "<html><body>Request blocked by WAF</body></html>";
    const byteLen = new TextEncoder().encode(page).length;
    const err = MpesaError.fromResponse(502, page, "text/html; charset=utf-8");
    expect(err.requestId).toBeNull();
    expect(err.errorCode).toBeNull();
    const msg = err.errorMessage ?? "";
    expect(msg).toContain("text/html; charset=utf-8");
    expect(msg).toContain(`${byteLen} bytes`);
    expect(msg).toContain("Request blocked by WAF");
    expect(err.message.startsWith("mpesa: HTTP 502 unparseable error body")).toBe(true);
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

  it("BOM-prefixed JSON fails parsing like python, yielding the diagnostic", () => {
    const err = MpesaError.fromResponse(418, '\ufeff{"requestId":"bom-prefixed"}');
    expect(err.requestId).toBeNull();
    expect(err.errorMessage).toContain("unparseable error body");
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
