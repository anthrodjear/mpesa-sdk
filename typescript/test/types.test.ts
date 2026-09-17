/**
 * types.ts unit tests — compile-time interface validation, MetadataMap
 * first-wins semantics, parseBalanceSegments, and wire-trap spot-checks.
 */

import { describe, it, expect } from "vitest";
import {
  STKPushRequest,
  STKQueryRequest,
  B2CRequest,
  B2CPayoutRequest,
  TransactionStatusRequest,
  AccountBalanceRequest,
  ReversalRequest,
  C2BRegisterRequest,
  C2BSimulateRequest,
  DynamicQRRequest,
  QRCodeRequest,
  STKPushResponse,
  STKQueryResponse,
  ConversationResponse,
  C2BAckResponse,
  QRCodeResponse,
  OAuthToken,
  StkCallbackResult,
  MetadataItem,
  MetadataMap,
  AsyncResult,
  AsyncResultEnvelope,
  BalanceSegment,
  parseBalanceSegments,
  isAccepted,
  parseAsyncResult,
  parseAsyncResultJson,
  MAX_ASYNC_RESULT_BYTES,
  TransactionType,
  CommandID,
  ResponseType,
  QRTrxCode,
} from "../src/types.js";

// ─── Section 1: Compile-time interface construction ──────────────────────────
// If these fail, the types.ts interfaces have structural errors.

describe("Request interfaces compile", () => {
  it("STKPushRequest constructs with all fields", () => {
    const req: STKPushRequest = {
      businessShortCode: "174379",
      password: "MTc0...",
      timestamp: "20210628122408",
      transactionType: TransactionType.BillPayGoodsGoods,
      amount: 1000,
      partyA: "254712345678",
      partyB: "254787654321",
      phoneNumber: "254712345678",
      callBackURL: "https://example.com/callback",
      accountReference: "ORDER-001",
      transactionDesc: "Test payment",
    };
    expect(req.businessShortCode).toBe("174379");
  });

  it("STKPushRequest has no occasion field (Go/Py parity — removed)", () => {
    const req: STKPushRequest = {
      businessShortCode: "174379",
      password: "MTc0...",
      timestamp: "20210628122408",
      transactionType: TransactionType.BillPayGoodsGoods,
      amount: 500,
      partyA: "254712345678",
      partyB: "254787654321",
      phoneNumber: "254712345678",
      callBackURL: "https://example.com/callback",
      accountReference: "ORDER-002",
      transactionDesc: "Test",
    };
    expect((req as Record<string, unknown>)["occassion"]).toBeUndefined();
    expect((req as Record<string, unknown>)["occasion"]).toBeUndefined();
  });

  it("STKQueryRequest constructs", () => {
    const req: STKQueryRequest = {
      businessShortCode: "174379",
      password: "MTc0...",
      timestamp: "20210628122408",
      checkoutRequestID: "ws_CO_1234",
    };
    expect(req.checkoutRequestID).toBe("ws_CO_1234");
  });

  it("B2CRequest constructs with resultURL", () => {
    const req: B2CRequest = {
      initiatorName: "test",
      securityCredential: "encrypted",
      commandID: CommandID.BusinessPayment,
      amount: 1000,
      partyA: "174379",
      partyB: "254712345678",
      remarks: "salary",
      queueTimeOutURL: "https://example.com/timeout",
      resultURL: "https://example.com/result",
    };
    expect(req.commandID.value).toBe("BusinessPayment");
    expect(req.resultURL).toBe("https://example.com/result");
  });

  it("TransactionStatusRequest constructs with resultURL and queueTimeOutURL", () => {
    const req: TransactionStatusRequest = {
      initiator: "test",
      securityCredential: "encrypted",
      commandID: CommandID.TransactionStatusQuery,
      transactionID: "QKH7BDX10S",
      partyA: "174379",
      resultURL: "https://example.com/result",
      queueTimeOutURL: "https://example.com/timeout",
    };
    expect(req.transactionID).toBe("QKH7BDX10S");
    expect(req.resultURL).toBe("https://example.com/result");
    expect(req.queueTimeOutURL).toBe("https://example.com/timeout");
  });

  it("AccountBalanceRequest constructs with resultURL", () => {
    const req: AccountBalanceRequest = {
      initiator: "test",
      securityCredential: "encrypted",
      commandID: CommandID.AccountBalance,
      partyA: "174379",
      queueTimeOutURL: "https://example.com/timeout",
      resultURL: "https://example.com/result",
    };
    expect(req.commandID.value).toBe("AccountBalance");
    expect(req.resultURL).toBe("https://example.com/result");
  });

  it("ReversalRequest constructs with amount, resultURL, and recieverIdentifierType misspelling", () => {
    const req: ReversalRequest = {
      initiator: "test",
      securityCredential: "encrypted",
      commandID: CommandID.ReverseTransaction,
      transactionID: "QKH7BDX10S",
      amount: 1000,
      receiverParty: "174379",
      recieverIdentifierType: "11",
      resultURL: "https://example.com/result",
      queueTimeOutURL: "https://example.com/timeout",
      remarks: "refund",
    };
    expect(req.recieverIdentifierType).toBe("11");
    expect(req.amount).toBe(1000);
    expect(req.resultURL).toBe("https://example.com/result");
  });

  it("C2BRegisterRequest constructs", () => {
    const req: C2BRegisterRequest = {
      shortCode: "174379",
      responseType: ResponseType.Success,
      confirmationURL: "https://example.com/confirm",
      validationURL: "https://example.com/validate",
    };
    expect(req.responseType.value).toBe("Success");
  });

  it("C2BSimulateRequest constructs", () => {
    const req: C2BSimulateRequest = {
      shortCode: "174379",
      commandID: CommandID.PayBill,
      amount: 100,
      msisdn: "254712345678",
      billRefNumber: "ORDER-001",
    };
    expect(req.amount).toBe(100);
  });

  it("DynamicQRRequest constructs with QRTrxCode enum", () => {
    const req: DynamicQRRequest = {
      merchantName: "Test Shop",
      refNo: "ORDER-001",
      amount: 1500,
      trxCode: QRTrxCode.BuyGoods,
      cpi: "174379",
      size: "300",
    };
    expect(req.trxCode.value).toBe("BG");
  });
});

// ─── Section 2: Response interfaces compile ──────────────────────────────────

describe("Response interfaces compile", () => {
  it("STKPushResponse constructs with PascalCase wire keys", () => {
    const res: STKPushResponse = {
      MerchantRequestID: "9210397",
      CheckoutRequestID: "ws_CO_1234",
      ResponseCode: "0",
      ResponseDescription: "Success",
      CustomerMessage: "Success. Request accepted for processing",
    };
    expect(res.ResponseCode).toBe("0");
  });

  it("STKQueryResponse constructs", () => {
    const res: STKQueryResponse = {
      ResponseCode: "0",
      ResponseDescription: "The service request has been accepted successfully",
      MerchantRequestID: "9210397",
      CheckoutRequestID: "ws_CO_1234",
      ResultCode: "1032",
      ResultDesc: "Request cancelled by user",
    };
    expect(res.ResultCode).toBe("1032");
  });

  it("ConversationResponse constructs", () => {
    const res: ConversationResponse = {
      OriginatorConversationID: "agt-1-29444-5948324",
      ConversationID: "agt_1_29444_5948324",
      ResponseCode: "0",
      ResponseDescription: "Accept the service request successfully.",
    };
    expect(res.ConversationID).toBe("agt_1_29444_5948324");
  });

  it("C2BAckResponse constructs with OriginatorCoversationID misspelling", () => {
    const res: C2BAckResponse = {
      OriginatorCoversationID: "agt-1-29444-5948324",
      ResponseCode: "0",
      ResponseDescription: "success",
    };
    expect(res.OriginatorCoversationID).toBe("agt-1-29444-5948324");
  });

  it("QRCodeResponse constructs", () => {
    const res: QRCodeResponse = {
      ResponseCode: "0",
      RequestID: "QR_001",
      ResponseDescription: "QR code generated",
      QRCode: "000401010...",
    };
    expect(res.QRCode).toBe("000401010...");
  });

  it("OAuthToken has expiresIn as string (wire trap)", () => {
    const token: OAuthToken = {
      accessToken: "VkE5U0VZNjg...",
      expiresIn: "3599",
      tokenType: "Bearer",
    };
    // expiresIn must be string, not number
    expect(typeof token.expiresIn).toBe("string");
    expect(token.expiresIn).toBe("3599");
  });
});

// ─── Section 3: Callback types compile ───────────────────────────────────────

describe("Callback types compile", () => {
  it("StkCallbackResult constructs with success code 0", () => {
    const cb: StkCallbackResult = {
      MerchantRequestID: "9210397",
      CheckoutRequestID: "ws_CO_1234",
      ResultCode: 0,
      ResultDesc: "The service request is processed successfully.",
      CallbackMetadata: {
        Item: [
          { Name: "Amount", Value: 1000 },
          { Name: "MpesaReceiptNumber", Value: "QKH7BDX10S" },
        ],
      },
    };
    expect(cb.ResultCode).toBe(0);
    expect(cb.CallbackMetadata?.Item).toHaveLength(2);
  });

  it("StkCallbackResult constructs without CallbackMetadata (failure)", () => {
    const cb: StkCallbackResult = {
      MerchantRequestID: "9210397",
      CheckoutRequestID: "ws_CO_1234",
      ResultCode: 1032,
      ResultDesc: "Request cancelled by user",
    };
    expect(cb.CallbackMetadata).toBeUndefined();
  });
});

// ─── Section 4: MetadataMap first-wins semantics ─────────────────────────────

describe("MetadataMap", () => {
  it("get() returns first value when duplicates exist", () => {
    const items: MetadataItem[] = [
      { Name: "Amount", Value: 1000 },
      { Name: "Amount", Value: 9999 },
    ];
    const map = new MetadataMap(items);
    expect(map.get("Amount")).toBe(1000);
  });

  it("set() is a no-op for existing keys (first-wins)", () => {
    const items: MetadataItem[] = [
      { Name: "Receipt", Value: "ABC123" },
    ];
    const map = new MetadataMap(items);
    map.set("Receipt", "XYZ789");
    expect(map.get("Receipt")).toBe("ABC123");
  });

  it("set() adds new keys", () => {
    const items: MetadataItem[] = [];
    const map = new MetadataMap(items);
    map.set("NewKey", 42);
    expect(map.get("NewKey")).toBe(42);
    expect(map.has("NewKey")).toBe(true);
  });

  it("has() returns correct boolean", () => {
    const items: MetadataItem[] = [
      { Name: "A", Value: 1 },
    ];
    const map = new MetadataMap(items);
    expect(map.has("A")).toBe(true);
    expect(map.has("B")).toBe(false);
  });

  it("entries() returns all pairs in insertion order", () => {
    const items: MetadataItem[] = [
      { Name: "X", Value: 10 },
      { Name: "Y", Value: 20 },
    ];
    const map = new MetadataMap(items);
    const entries = [...map.entries()];
    expect(entries).toEqual([["X", 10], ["Y", 20]]);
  });

  it("size reflects unique key count", () => {
    const items: MetadataItem[] = [
      { Name: "A", Value: 1 },
      { Name: "A", Value: 2 },
      { Name: "B", Value: 3 },
    ];
    const map = new MetadataMap(items);
    expect(map.size).toBe(2);
  });
});

// ─── Section 5: parseBalanceSegments ─────────────────────────────────────────

describe("parseBalanceSegments", () => {
  it("parses a single balance segment", () => {
    const text =
      "Available Account Balance|KES|1234.56|0.00|0.00|0.00";
    const segments = parseBalanceSegments(text);
    expect(segments).toHaveLength(1);
    expect(segments[0].accountName).toBe("Available Account Balance");
    expect(segments[0].currency).toBe("KES");
    expect(segments[0].available).toBe(1234.56);
    expect(segments[0].uncleared).toBe(0);
    expect(segments[0].reserved).toBe(0);
    expect(segments[0].min).toBe(0);
  });

  it("parses multiple & separated segments", () => {
    const text =
      "Available Account Balance|KES|1234.56|0.00|0.00|0.00&" +
      "Float Balance|KES|5000.00|100.00|200.00|50.00";
    const segments = parseBalanceSegments(text);
    expect(segments).toHaveLength(2);
    expect(segments[1].accountName).toBe("Float Balance");
    expect(segments[1].available).toBe(5000);
    expect(segments[1].reserved).toBe(200);
  });

  it("skips malformed rows gracefully", () => {
    const text =
      "Valid|KES|100|0|0|0&BadRow|Only|3&AlsoValid|USD|50|0|0|0";
    const segments = parseBalanceSegments(text);
    expect(segments).toHaveLength(2);
    expect(segments[0].currency).toBe("KES");
    expect(segments[1].currency).toBe("USD");
  });

  it("returns empty array for empty string", () => {
    expect(parseBalanceSegments("")).toEqual([]);
  });

  it("handles trailing & gracefully", () => {
    const text = "Available Account Balance|KES|100|0|0|0&";
    const segments = parseBalanceSegments(text);
    expect(segments).toHaveLength(1);
    expect(segments[0].available).toBe(100);
  });
});

// ─── Section 6: AsyncResult compiles ─────────────────────────────────────────

describe("AsyncResult compiles", () => {
  it("constructs with essential fields", () => {
    const result: AsyncResult = {
      ResultType: 0,
      ResultCode: "0",
      ResultDesc: "Completed",
      OriginatorConversationID: "agt-1-29444-5948324",
      ConversationID: "agt_1_29444_5948324",
    };
    expect(result.ResultCode).toBe("0");
  });

  it("omits optional fields", () => {
    const result: AsyncResult = {
      ResultType: 0,
      ResultCode: "0",
      ResultDesc: "Completed",
      OriginatorConversationID: "agt-1",
      ConversationID: "agt_1",
    };
    expect(result.TransactionReceipt).toBeUndefined();
  });
});

// ─── Section 7: Enums re-export works ────────────────────────────────────────

describe("Enums re-exported from types.ts", () => {
  it("TransactionType members accessible", () => {
    expect(TransactionType.BillPayGoods.value).toBe("CustomerPayBillOnline");
    expect(TransactionType.BillPayGoodsGoods.value).toBe("CustomerBuyGoodsOnline");
  });

  it("CommandID members accessible", () => {
    expect(CommandID.BusinessPayment.value).toBe("BusinessPayment");
    expect(CommandID.TransactionStatusQuery.value).toBe("TransactionStatusQuery");
    expect(CommandID.AccountBalance.value).toBe("AccountBalance");
    expect(CommandID.ReverseTransaction.value).toBe("TransactionReversal");
  });

  it("ResponseType members accessible", () => {
    expect(ResponseType.Success.value).toBe("Success");
    expect(ResponseType.Fail.value).toBe("Fail");
  });

  it("QRTrxCode members accessible", () => {
    expect(QRTrxCode.BuyGoods.value).toBe("BG");
    expect(QRTrxCode.WithdrawAtAgentTill.value).toBe("WA");
    expect(QRTrxCode.Paybill.value).toBe("PB");
    expect(QRTrxCode.SendMoney.value).toBe("SM");
    expect(QRTrxCode.SendToBusiness.value).toBe("SB");
  });
});

// ─── Section 8: Wire-trap spot-checks ────────────────────────────────────────

describe("Wire-trap annotations", () => {
  it("B2CRequest.occasion keeps the double-s wire key (STK Push has none)", () => {
    const req: B2CRequest = {
      initiatorName: "test",
      securityCredential: "enc",
      commandID: CommandID.BusinessPayment,
      amount: 100,
      partyA: "174379",
      partyB: "254712345678",
      remarks: "test",
      queueTimeOutURL: "https://example.com/to",
      resultURL: "https://example.com/res",
      occasion: "promo",
    };
    expect(req.occasion).toBe("promo");
    expect((req as Record<string, unknown>).hasOwnProperty("occassion")).toBe(false);
  });

  it("ReversalRequest.recieverIdentifierType uses deliberate misspelling", () => {
    const req: ReversalRequest = {
      initiator: "test",
      securityCredential: "enc",
      commandID: CommandID.ReverseTransaction,
      transactionID: "TX1",
      amount: 500,
      receiverParty: "174379",
      recieverIdentifierType: "11",
      resultURL: "https://example.com/result",
      queueTimeOutURL: "https://example.com/timeout",
      remarks: "refund",
    };
    expect(req.recieverIdentifierType).toBe("11");
  });

  it("C2BAckResponse.OriginatorCoversationID uses deliberate misspelling", () => {
    const res: C2BAckResponse = {
      OriginatorCoversationID: "agt-1-29444-5948324",
      ResponseCode: "0",
      ResponseDescription: "success",
    };
    expect(res.OriginatorCoversationID).toBe("agt-1-29444-5948324");
  });

  it("B2CRequest.queueTimeOutURL uses capital T (not timeout)", () => {
    const req: B2CRequest = {
      initiatorName: "test",
      securityCredential: "enc",
      commandID: CommandID.BusinessPayment,
      amount: 100,
      partyA: "174379",
      partyB: "254712345678",
      remarks: "test",
      queueTimeOutURL: "https://example.com/timeout",
      resultURL: "https://example.com/result",
    };
    expect(req.queueTimeOutURL).toBe("https://example.com/timeout");
  });
});

// ─── Section 9: MetadataItem compiles ────────────────────────────────────────

describe("ResultURL present on async request interfaces", () => {
  it("B2CRequest has resultURL", () => {
    const req: B2CRequest = {
      initiatorName: "test", securityCredential: "enc",
      commandID: CommandID.BusinessPayment, amount: 100,
      partyA: "174379", partyB: "254712345678", remarks: "t",
      queueTimeOutURL: "https://example.com/to",
      resultURL: "https://example.com/res",
    };
    expect(typeof req.resultURL).toBe("string");
  });

  it("ReversalRequest has resultURL", () => {
    const req: ReversalRequest = {
      initiator: "test", securityCredential: "enc",
      commandID: CommandID.ReverseTransaction, transactionID: "TX1",
      amount: 100, receiverParty: "174379", remarks: "t",
      resultURL: "https://example.com/res",
      queueTimeOutURL: "https://example.com/to",
    };
    expect(typeof req.resultURL).toBe("string");
  });

  it("TransactionStatusRequest has resultURL and queueTimeOutURL", () => {
    const req: TransactionStatusRequest = {
      initiator: "test", securityCredential: "enc",
      commandID: CommandID.TransactionStatusQuery,
      transactionID: "TX1", partyA: "174379",
      resultURL: "https://example.com/res",
      queueTimeOutURL: "https://example.com/to",
    };
    expect(typeof req.resultURL).toBe("string");
    expect(typeof req.queueTimeOutURL).toBe("string");
  });

  it("AccountBalanceRequest has resultURL", () => {
    const req: AccountBalanceRequest = {
      initiator: "test", securityCredential: "enc",
      commandID: CommandID.AccountBalance, partyA: "174379",
      queueTimeOutURL: "https://example.com/to",
      resultURL: "https://example.com/res",
    };
    expect(typeof req.resultURL).toBe("string");
  });
});

// ─── Section 10: MetadataItem compiles ───────────────────────────────────────

describe("MetadataItem compiles", () => {
  it("constructs with string and number values", () => {
    const item1: MetadataItem = { Name: "Amount", Value: 1000 };
    const item2: MetadataItem = { Name: "Receipt", Value: "QKH7BDX10S" };
    expect(item1.Value).toBe(1000);
    expect(item2.Value).toBe("QKH7BDX10S");
  });
});

// ─── Section 11: isAccepted ──────────────────────────────────────────────────

describe("isAccepted", () => {
  it("returns true for ResponseCode 0", () => {
    expect(isAccepted({ ResponseCode: "0" })).toBe(true);
  });
  it("returns false for non-zero ResponseCode", () => {
    expect(isAccepted({ ResponseCode: "1" })).toBe(false);
  });
});

// ─── Section 12: parseAsyncResult ────────────────────────────────────────────

describe("parseAsyncResult", () => {
  it("parses flat envelope", () => {
    const result = parseAsyncResult({
      ResultCode: "0", ResultDesc: "Success",
      MerchantRequestID: "m1", CheckoutRequestID: "c1",
    });
    expect(result.ResultCode).toBe("0");
    expect(result.MerchantRequestID).toBe("m1");
  });

  it("unwraps { Result: { ... } } envelope (Daraja wire shape)", () => {
    const result = parseAsyncResult({
      Result: {
        ResultCode: "0", ResultDesc: "Completed",
        MerchantRequestID: "m2", CheckoutRequestID: "c2",
      },
    });
    expect(result.ResultCode).toBe("0");
    expect(result.ResultDesc).toBe("Completed");
    expect(result.MerchantRequestID).toBe("m2");
    expect(result.CheckoutRequestID).toBe("c2");
  });

  it("accepts ResultCode as string (cross-language parity)", () => {
    const result = parseAsyncResult({
      ResultCode: "1032", ResultDesc: "Request cancelled by user",
    });
    expect(result.ResultCode).toBe("1032");
  });

  it("coerces numeric ResultCode/ResultDesc via String() (Go FlexString parity)", () => {
    const flat = parseAsyncResult({ ResultCode: 0, ResultDesc: 0 });
    expect(flat.ResultCode).toBe("0");
    expect(flat.ResultDesc).toBe("0");

    const wrapped = parseAsyncResult({
      Result: { ResultCode: 1032, ResultDesc: "Request cancelled by user" },
    });
    expect(wrapped.ResultCode).toBe("1032");
  });

  it("rejects non-string/number ResultCode (boolean/null)", () => {
    expect(() =>
      parseAsyncResult({ ResultCode: true, ResultDesc: "Success" }),
    ).toThrow("invalid");
  });

  it("throws on missing ResultCode", () => {
    expect(() => parseAsyncResult({ ResultDesc: "x" })).toThrow("invalid");
  });

  it("throws on null", () => {
    expect(() => parseAsyncResult(null)).toThrow("invalid");
  });

  it("throws on non-object", () => {
    expect(() => parseAsyncResult("hello")).toThrow("invalid");
  });

  it("throws when Result wrapper exists but inner is not an object", () => {
    expect(() => parseAsyncResult({ Result: "not-an-object" })).toThrow(
      "invalid",
    );
  });

  it("throws when wrapped envelope is missing ResultCode", () => {
    expect(() =>
      parseAsyncResult({ Result: { ResultDesc: "fail" } }),
    ).toThrow("invalid");
  });
});

// ─── Section 13: parseAsyncResultJson (bounded entry) ─────────────────────────
// SECURITY: never JSON.parse uncapped callback bodies — this entry enforces
// the 1 MiB cap BEFORE parsing, then delegates to parseAsyncResult.

describe("parseAsyncResultJson", () => {
  it("parses a valid flat envelope from a string", () => {
    const result = parseAsyncResultJson(
      '{"ResultCode":"0","ResultDesc":"Completed","MerchantRequestID":"m1"}',
    );
    expect(result.ResultCode).toBe("0");
    expect(result.ResultDesc).toBe("Completed");
    expect(result.MerchantRequestID).toBe("m1");
  });

  it("parses a valid wrapped envelope from Uint8Array bytes", () => {
    const bytes = new TextEncoder().encode(
      '{"Result":{"ResultCode":1032,"ResultDesc":"Request cancelled by user"}}',
    );
    const result = parseAsyncResultJson(bytes);
    expect(result.ResultCode).toBe("1032");
    expect(result.ResultDesc).toBe("Request cancelled by user");
  });

  it("delegates envelope validation (missing ResultCode throws TypeError)", () => {
    expect(() => parseAsyncResultJson('{"ResultDesc":"x"}')).toThrow(TypeError);
    expect(() => parseAsyncResultJson(new TextEncoder().encode("null"))).toThrow(
      TypeError,
    );
  });

  it("rejects an oversize string body (> 1 MiB UTF-8)", () => {
    const overhead = new TextEncoder().encode(
      '{"ResultCode":"0","ResultDesc":""}',
    ).length;
    const oversize =
      '{"ResultCode":"0","ResultDesc":"' +
      "A".repeat(MAX_ASYNC_RESULT_BYTES - overhead + 1) +
      '"}';
    expect(new TextEncoder().encode(oversize).length).toBeGreaterThan(
      MAX_ASYNC_RESULT_BYTES,
    );
    expect(() => parseAsyncResultJson(oversize)).toThrow(/exceeds/);
  });

  it("rejects oversize Uint8Array bytes (> 1 MiB)", () => {
    const oversize = new Uint8Array(MAX_ASYNC_RESULT_BYTES + 1);
    oversize.fill(0x20); // spaces — cap must fire before JSON.parse runs
    expect(() => parseAsyncResultJson(oversize)).toThrow(/exceeds/);
  });

  it("cap counts UTF-8 bytes, not UTF-16 units (multibyte trap)", () => {
    // "é" is 1 UTF-16 unit but 2 UTF-8 bytes: 600k chars = 1.2 MiB.
    const tricky = "é".repeat(600_000);
    expect(tricky.length).toBeLessThan(MAX_ASYNC_RESULT_BYTES);
    expect(() => parseAsyncResultJson(tricky)).toThrow(/exceeds/);
  });

  it("accepts a body of exactly 1 MiB", () => {
    const overhead = new TextEncoder().encode(
      '{"ResultCode":"0","ResultDesc":""}',
    ).length;
    const exact =
      '{"ResultCode":"0","ResultDesc":"' +
      "A".repeat(MAX_ASYNC_RESULT_BYTES - overhead) +
      '"}';
    expect(new TextEncoder().encode(exact).length).toBe(MAX_ASYNC_RESULT_BYTES);
    const result = parseAsyncResultJson(exact);
    expect(result.ResultCode).toBe("0");
  });

  it("MAX_ASYNC_RESULT_BYTES is 1 MiB", () => {
    expect(MAX_ASYNC_RESULT_BYTES).toBe(1 << 20);
  });
});

// ─── Section 14: MetadataMap.duplicateKeys ────────────────────────────────────
// Go DuplicateKeys / Python duplicate_keys parity: counts EXTRA occurrences.

describe("MetadataMap.duplicateKeys", () => {
  it("returns 0 with no duplicates", () => {
    const map = new MetadataMap([
      { Name: "A", Value: 1 },
      { Name: "B", Value: 2 },
    ]);
    expect(map.duplicateKeys()).toBe(0);
  });

  it("returns 0 for an empty map", () => {
    expect(new MetadataMap([]).duplicateKeys()).toBe(0);
  });

  it("counts one shadowed item ([A, A, B] → 1)", () => {
    const map = new MetadataMap([
      { Name: "Amount", Value: 1000 },
      { Name: "Amount", Value: 9999 },
      { Name: "Receipt", Value: "ABC" },
    ]);
    expect(map.get("Amount")).toBe(1000); // first still wins
    expect(map.duplicateKeys()).toBe(1);
  });

  it("counts extra occurrences, not distinct keys ([A, A, A] → 2)", () => {
    const map = new MetadataMap([
      { Name: "A", Value: 1 },
      { Name: "A", Value: 2 },
      { Name: "A", Value: 3 },
    ]);
    expect(map.duplicateKeys()).toBe(2);
  });

  it("set() never affects duplicateKeys (wire duplicates fixed at construction)", () => {
    const map = new MetadataMap([{ Name: "A", Value: 1 }]);
    map.set("B", 2); // new key
    map.set("A", 999); // no-op (first-wins)
    expect(map.duplicateKeys()).toBe(0);
  });
});

// ─── Section 15: Request type aliases + numeric STKQuery ResultCode ──────────

describe("request type aliases (non-breaking)", () => {
  it("B2CPayoutRequest is assignable to/from B2CRequest (identical wire)", () => {
    const alias: B2CPayoutRequest = {
      initiatorName: "test",
      securityCredential: "enc",
      commandID: CommandID.BusinessPayment,
      amount: 100,
      partyA: "174379",
      partyB: "254712345678",
      remarks: "test",
      queueTimeOutURL: "https://example.com/to",
      resultURL: "https://example.com/res",
    };
    const canonical: B2CRequest = alias;
    expect(canonical.amount).toBe(100);
  });

  it("QRCodeRequest is assignable to/from DynamicQRRequest (identical wire)", () => {
    const alias: QRCodeRequest = {
      merchantName: "Shop",
      refNo: "R1",
      amount: 50,
      trxCode: QRTrxCode.BuyGoods,
      cpi: "174379",
      size: "300",
    };
    const canonical: DynamicQRRequest = alias;
    expect(canonical.trxCode.value).toBe("BG");
  });

  it("STKQueryResponse accepts numeric ResultCode (wire trap, normalized by stkQuery)", () => {
    const res: STKQueryResponse = {
      ResponseCode: "0",
      ResponseDescription: "ok",
      MerchantRequestID: "m",
      CheckoutRequestID: "c",
      ResultCode: 1032,
      ResultDesc: "cancelled",
    };
    expect(String(res.ResultCode)).toBe("1032");
  });
});

// ─── Section 16: parseBalanceSegments hardening ──────────────────────────────

describe("parseBalanceSegments hardening", () => {
  it("preserves the trimmed raw row", () => {
    const segments = parseBalanceSegments("  A|KES|100|0|0|0  ");
    expect(segments).toHaveLength(1);
    expect(segments[0]!.raw).toBe("A|KES|100|0|0|0");
  });

  it('rejects parseFloat traps "1_000" (→ 1) and "0x10" (→ 0)', () => {
    expect(parseBalanceSegments("A|KES|1_000|0|0|0")).toEqual([]);
    expect(parseBalanceSegments("A|KES|0x10|0|0|0")).toEqual([]);
  });

  it("rejects Arabic-Indic digits (Unicode-ND)", () => {
    // U+0661 U+0662 U+0663 — parseFloat mis-parses, _BALANCE_NUM_RE rejects.
    expect(parseBalanceSegments("A|KES|١٢٣|0|0|0")).toEqual([]);
  });

  it("rejects non-numeric garbage in any numeric column", () => {
    expect(parseBalanceSegments("A|KES|100|abc|0|0")).toEqual([]);
    expect(parseBalanceSegments("A|KES|100|0|0|NaN")).toEqual([]);
  });
});
