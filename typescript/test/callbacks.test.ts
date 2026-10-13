/**
 * Tests for src/callbacks.ts — STK callback ingestion.
 *
 * Mirrors python/tests/test_callbacks.py case-for-case (which itself
 * mirrors go/callbacks_test.go): success metadata extraction, absent
 * metadata tolerance, first-wins duplicates, hostile shapes/types, the
 * 1 MiB cap, and classification wiring.
 */
import { describe, expect, it } from "vitest";
import { StkCallback, parseSTKCallback } from "../src/callbacks.js";
import { MpesaDecodeError, MpesaError } from "../src/errors.js";
import { ResultClass } from "../src/classification.js";

const SUCCESS_RAW = `{
    "Body": {"stkCallback": {
        "MerchantRequestID": "29115-34620561-1",
        "CheckoutRequestID": "ws_CO_191220191020363925",
        "ResultCode": 0,
        "ResultDesc": "The service request is processed successfully.",
        "CallbackMetadata": {"Item": [
            {"Name": "Amount", "Value": 1.0},
            {"Name": "MpesaReceiptNumber", "Value": "NLJ7RT61SV"},
            {"Name": "TransactionDate", "Value": 20191219102115},
            {"Name": "PhoneNumber", "Value": 254708374149}
        ]}
    }}}`;

function envelope(inner: string): string {
  return `{"Body":{"stkCallback":${inner}}}`;
}

describe("StkCallback success path", () => {
  it("extracts the full metadata set (Python test_success_callback_full_metadata)", () => {
    const res = parseSTKCallback(SUCCESS_RAW);
    expect(res.MerchantRequestID).toBe("29115-34620561-1");
    expect(res.CheckoutRequestID).toBe("ws_CO_191220191020363925");
    expect(res.ResultCode).toBe("0");
    expect(res.classify()).toBe(ResultClass.SUCCESS);
    expect(res.amount()).toBe(1);
    expect(typeof res.amount()).toBe("number");
    expect(res.mpesaReceiptNumber()).toBe("NLJ7RT61SV");
    // Integral magnitudes preserved exactly — never float-corrupted.
    expect(res.transactionDate()).toBe(20191219102115);
    const phone = res.phoneNumber();
    expect(phone).toBe("254708374149");
    expect(phone).toMatch(/^[0-9]+$/);
  });

  it("accepts the raw Uint8Array body form", () => {
    const res = parseSTKCallback(new TextEncoder().encode(SUCCESS_RAW));
    expect(res.CheckoutRequestID).toBe("ws_CO_191220191020363925");
  });

  it("normalizes string and float-encoded ResultCode forms", () => {
    for (const code of ['"0"', "0", "0.0"]) {
      const res = parseSTKCallback(
        envelope('{"MerchantRequestID":"m","CheckoutRequestID":"c","ResultCode":' + code + ',"ResultDesc":"d"}'),
      );
      expect(res.ResultCode).toBe("0");
      expect(res.classify()).toBe(ResultClass.SUCCESS);
    }
  });
});

describe("StkCallback failure tolerance", () => {
  it("tolerates absent CallbackMetadata (Python test_failure_callback_absent_metadata_tolerated)", () => {
    const res = parseSTKCallback(
      '{"Body":{"stkCallback":{"MerchantRequestID":"x","CheckoutRequestID":"ws_CO_1","ResultCode":1037,"ResultDesc":"DS timeout"}}}',
    );
    expect(res.metadata().size).toBe(0);
    expect(res.amount()).toBeNull();
    expect(res.mpesaReceiptNumber()).toBeNull();
    expect(res.transactionDate()).toBeNull();
    expect(res.phoneNumber()).toBeNull();
    // 1037 is documented INCONCLUSIVE — never auto-fail.
    expect(res.classify()).toBe(ResultClass.INCONCLUSIVE);
  });
});

describe("StkCallback metadata semantics", () => {
  it("first-wins on duplicates, counted (Python test_duplicate_metadata_first_wins_and_counted)", () => {
    const res = parseSTKCallback(
      '{"Body":{"stkCallback":{"CheckoutRequestID":"ws_CO_1","ResultCode":"0","MerchantRequestID":"m","ResultDesc":"ok",' +
        '"CallbackMetadata":{"Item":[' +
        '{"Name":"MpesaReceiptNumber","Value":"AAA111"},' +
        '{"Name":"Amount","Value":10},' +
        '{"Name":"MpesaReceiptNumber","Value":"BBB222"}]}}}}',
    );
    expect(res.mpesaReceiptNumber()).toBe("AAA111");
    expect(res.metadata().get("Amount")).toBe(10);
    expect(res.duplicateKeys()).toBe(1);
  });

  it("absent or null values surface as null entries (Python test_absent_or_null_values_surface_as_none)", () => {
    const res = parseSTKCallback(
      '{"Body":{"stkCallback":{"CheckoutRequestID":"ws_CO_1","ResultCode":1,"MerchantRequestID":"m","ResultDesc":"fail",' +
        '"CallbackMetadata":{"Item":[{"Name":"Ghost"},{"Name":"Nothing","Value":null}]}}}}',
    );
    const md = res.metadata();
    expect(md.has("Ghost")).toBe(true);
    expect(md.get("Ghost")).toBeNull();
    expect(md.get("Nothing")).toBeNull();
  });

  it("public items() keeps duplicates and order (Python test_public_items_tuple_and_duplicate_amount_first_wins)", () => {
    const res = parseSTKCallback(
      envelope(
        '{"MerchantRequestID":"m","CheckoutRequestID":"ws_CO_1","ResultCode":0,"ResultDesc":"ok",' +
          '"CallbackMetadata":{"Item":[{"Name":"Amount","Value":5},{"Name":"Amount","Value":9}]}}',
      ),
    );
    expect(res.items().length).toBe(2);
    expect(res.amount()).toBe(5);
    expect(res.duplicateKeys()).toBe(1);
  });

  it("duplicateKeys is zero on the baseline (Python test_duplicate_keys_zero_baseline)", () => {
    const res = parseSTKCallback(
      envelope(
        '{"MerchantRequestID":"m","CheckoutRequestID":"ws_CO_1","ResultCode":0,"ResultDesc":"ok",' +
          '"CallbackMetadata":{"Item":[{"Name":"Amount","Value":5}]}}',
      ),
    );
    expect(res.duplicateKeys()).toBe(0);
  });

  it("drops scalar and non-dict items (Python test_scalar_and_nondict_items_dropped)", () => {
    const res = parseSTKCallback(
      envelope(
        '{"MerchantRequestID":"m","CheckoutRequestID":"c","ResultCode":0,"ResultDesc":"ok",' +
          '"CallbackMetadata":{"Item":["scalar",42,{"Name":"A","Value":1}]}}',
      ),
    );
    expect([...res.metadata().entries()].map(([k]) => k)).toEqual(["A"]);
  });
});

describe("StkCallback hostile shapes", () => {
  const hostile = [
    "{}",
    '{"Body":{}}',
    '{"Body":[]}',
    '{"Body":{"nope":1}}',
    "{oops",
  ];

  for (const raw of hostile) {
    it(`rejects ${raw.slice(0, 24) || "empty"} with a typed error`, () => {
      expect(() => parseSTKCallback(raw)).toThrow(MpesaDecodeError);
    });
  }

  it("names the missing scalar key (Python test_missing_inner_scalar_names_key)", () => {
    expect(() => parseSTKCallback('{"Body":{"stkCallback":{"MerchantRequestID":"x"}}}')).toThrow(
      /missing .*CheckoutRequestID/,
    );
  });

  it("names an empty inner object's missing keys (Python test_absent_result_code_error_names_key)", () => {
    expect(() => parseSTKCallback('{"Body":{"stkCallback":{}}}')).toThrow(/missing .*ResultCode/);
  });

  it("non-object Body keeps the malformed phrasing (Python test_non_object_body_malformed_phrasing)", () => {
    expect(() => parseSTKCallback('{"Body":[]}')).toThrow(/missing or malformed Body/);
  });

  it("deep nesting yields the uniform unparseable message (Python test_deep_nesting_uniform_unparseable_message)", () => {
    expect(() => parseSTKCallback("[".repeat(2000))).toThrow(/unparseable callback body/);
  });

  it("invalid UTF-8 bytes fail shape validation, not the decoder (Python test_invalid_utf8_bytes_value_error)", () => {
    expect(() =>
      parseSTKCallback(new Uint8Array([0x7b, 0x22, 0x42, 0x6f, 0x64, 0x79, 0x22, 0x3a, 0x22, 0xff, 0xfe, 0x22, 0x7d])),
    ).toThrow(MpesaDecodeError);
  });
});

describe("StkCallback hostile metadata values", () => {
  function metaResult(itemsJson: string): StkCallback {
    return parseSTKCallback(
      envelope(
        '{"MerchantRequestID":"m","CheckoutRequestID":"ws_CO_1","ResultCode":0,"ResultDesc":"ok",' +
          '"CallbackMetadata":{"Item":[' + itemsJson + "]}}",
      ),
    );
  }

  it("huge int Amount returns null, not a crash (Python test_amount_huge_int_returns_none_not_crash)", () => {
    const res = metaResult('{"Name":"Amount","Value":' + "9".repeat(400) + "}");
    expect(res.amount()).toBeNull();
  });

  it("string-encoded Amount accepted, boolean rejected (Python test_amount_accepts_string_encoded)", () => {
    expect(metaResult('{"Name":"Amount","Value":"1.0"}').amount()).toBe(1);
    expect(metaResult('{"Name":"Amount","Value":true}').amount()).toBeNull();
  });

  it("huge-int and non-digit PhoneNumber rejected, string accepted (Python test_phone_huge_int_and_non_digit_strings_rejected)", () => {
    expect(metaResult('{"Name":"PhoneNumber","Value":' + "7".repeat(4301) + "}").phoneNumber()).toBeNull();
    expect(metaResult('{"Name":"PhoneNumber","Value":"not-a-phone"}').phoneNumber()).toBeNull();
    expect(metaResult('{"Name":"PhoneNumber","Value":"254708374149"}').phoneNumber()).toBe("254708374149");
    expect(metaResult('{"Name":"PhoneNumber","Value":true}').phoneNumber()).toBeNull();
  });

  it("unnameable item is kept under the empty key (Python test_item_name_hostile_int_never_raises)", () => {
    const res = metaResult('{"Name":' + "3".repeat(4301) + ',"Value":1}');
    expect(res.metadata().get("")).toBe(1);
  });

  it("string-encoded TransactionDate accepted, boolean rejected (Python test_transaction_date_string_encoded_accepted_bool_rejected)", () => {
    expect(metaResult('{"Name":"TransactionDate","Value":"20191219102115"}').transactionDate())
      .toBe(20191219102115);
    expect(metaResult('{"Name":"TransactionDate","Value":true}').transactionDate()).toBeNull();
  });
});

describe("StkCallback size cap", () => {
  it("rejects a string body over 1 MiB (Python test_oversize_body_rejected)", () => {
    expect(() => parseSTKCallback('{"Body":"' + "A".repeat(1_048_577) + '"}')).toThrow(
      "mpesa: HTTP 413 callback body response exceeds 1048576 bytes",
    );
  });

  it("rejects a bytes body over 1 MiB (Python test_oversize_bytes_body_rejected)", () => {
    const oversize = new Uint8Array(1_048_577).fill(0x41);
    expect(() => parseSTKCallback(oversize)).toThrow(
      "mpesa: HTTP 413 callback body response exceeds 1048576 bytes",
    );
  });

  it("the over-cap rejection is a typed MpesaError (HTTP 413)", () => {
    const oversize = new Uint8Array(1_048_577).fill(0x41);
    let caught: unknown;
    try {
      parseSTKCallback(oversize);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MpesaError);
    expect((caught as MpesaError).statusCode).toBe(413);
  });

  it("accepts a body at exactly 1 MiB", () => {
    const overhead = '{"Body":{"stkCallback":{"MerchantRequestID":"m","CheckoutRequestID":"c","ResultCode":0,"ResultDesc":"ok","CallbackMetadata":{"Item":[{"Name":"A","Value":"'.length +
      '"}]}}}}'.length;
    const pad = 1_048_576 - overhead;
    expect(() =>
      parseSTKCallback('{"Body":{"stkCallback":{"MerchantRequestID":"m","CheckoutRequestID":"c","ResultCode":0,"ResultDesc":"ok","CallbackMetadata":{"Item":[{"Name":"A","Value":"' + "A".repeat(pad) + '"}]}}}}'),
    ).not.toThrow();
  });
});

describe("StkCallback classification wiring", () => {
  it("classifies across encodings (Python test_classify_wiring_across_encodings)", () => {
    for (const [code, want] of [
      ["0", ResultClass.SUCCESS],
      ['"0"', ResultClass.SUCCESS],
      ["0.0", ResultClass.SUCCESS],
      ["1032", ResultClass.FAILURE],
      ["1037", ResultClass.INCONCLUSIVE],
      ["1001", ResultClass.INCONCLUSIVE],
      ["26", ResultClass.INCONCLUSIVE],
      ["4999", ResultClass.INCONCLUSIVE],
    ] as Array<[string, ResultClass]>) {
      const res = parseSTKCallback(
        '{"Body":{"stkCallback":{"MerchantRequestID":"m","CheckoutRequestID":"c","ResultCode":' + code + ',"ResultDesc":"d"}}}',
      );
      expect(res.classify(), `code ${code}`).toBe(want);
    }
  });

  it("null ResultCode is INCONCLUSIVE (Python test_null_result_code_indeterminate)", () => {
    const res = parseSTKCallback(
      '{"Body":{"stkCallback":{"MerchantRequestID":"m","CheckoutRequestID":"c","ResultCode":null,"ResultDesc":"?"}}}',
    );
    expect(res.classify()).toBe(ResultClass.INCONCLUSIVE);
  });

  it("accepts a bare stkCallback result object (Go ParseSTKCallback parity)", () => {
    const res = parseSTKCallback(
      '{"MerchantRequestID":"m","CheckoutRequestID":"ws_CO_1","ResultCode":0,"ResultDesc":"ok",' +
        '"CallbackMetadata":{"Item":[{"Name":"Amount","Value":7}]}}',
    );
    expect(res.CheckoutRequestID).toBe("ws_CO_1");
    expect(res.amount()).toBe(7);
  });

  it("bare objects without any identifying key are rejected", () => {
    expect(() => parseSTKCallback('{"unrelated":true}')).toThrow(MpesaDecodeError);
  });
});
