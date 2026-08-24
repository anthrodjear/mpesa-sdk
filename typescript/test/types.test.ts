/**
 * types.ts unit tests — compile-time interface validation, MetadataMap
 * first-wins semantics, parseBalanceSegments, and wire-trap spot-checks.
 */

import { describe, it, expect } from "vitest";
import {
  STKPushRequest,
  STKQueryRequest,
  B2CRequest,
  TransactionStatusRequest,
  AccountBalanceRequest,
  ReversalRequest,
  C2BRegisterRequest,
  C2BSimulateRequest,
  DynamicQRRequest,
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
  BalanceSegment,
  parseBalanceSegments,
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

  it("STKPushRequest omits optional occassion (double-s)", () => {
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
    expect(req.occassion).toBeUndefined();
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

  it("B2CRequest constructs", () => {
    const req: B2CRequest = {
      initiatorName: "test",
      securityCredential: "encrypted",
      commandID: CommandID.BusinessPayment,
      amount: 1000,
      partyA: "174379",
      partyB: "254712345678",
      remarks: "salary",
      queueTimeOutURL: "https://example.com/timeout",
    };
    expect(req.commandID.value).toBe("BusinessPayment");
  });

  it("TransactionStatusRequest constructs", () => {
    const req: TransactionStatusRequest = {
      initiator: "test",
      securityCredential: "encrypted",
      commandID: CommandID.TransactionStatusQuery,
      transactionID: "QKH7BDX10S",
      partyA: "174379",
    };
    expect(req.transactionID).toBe("QKH7BDX10S");
  });

  it("AccountBalanceRequest constructs", () => {
    const req: AccountBalanceRequest = {
      initiator: "test",
      securityCredential: "encrypted",
      commandID: CommandID.AccountBalance,
      partyA: "174379",
      queueTimeOutURL: "https://example.com/timeout",
    };
    expect(req.commandID.value).toBe("AccountBalance");
  });

  it("ReversalRequest constructs with recieverIdentifierType misspelling", () => {
    const req: ReversalRequest = {
      initiator: "test",
      securityCredential: "encrypted",
      commandID: CommandID.ReverseTransaction,
      transactionID: "QKH7BDX10S",
      receiverParty: "174379",
      recieverIdentifierType: "11",
      remarks: "refund",
    };
    expect(req.recieverIdentifierType).toBe("11");
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
      trxCode: QRTrxCode.DynamicQRCode,
      cpi: "174379",
      size: "300",
    };
    expect(req.trxCode.value).toBe("DynamicQRCode");
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
});

// ─── Section 6: AsyncResult compiles ─────────────────────────────────────────

describe("AsyncResult compiles", () => {
  it("constructs with essential fields", () => {
    const result: AsyncResult = {
      ResultType: 0,
      ResultCode: 0,
      ResultDesc: "Completed",
      OriginatorConversationID: "agt-1-29444-5948324",
      ConversationID: "agt_1_29444_5948324",
    };
    expect(result.ResultCode).toBe(0);
  });

  it("omits optional fields", () => {
    const result: AsyncResult = {
      ResultType: 0,
      ResultCode: 0,
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
    expect(CommandID.ReverseTransaction.value).toBe("ReverseTransaction");
  });

  it("ResponseType members accessible", () => {
    expect(ResponseType.Success.value).toBe("Success");
    expect(ResponseType.Fail.value).toBe("Fail");
  });

  it("QRTrxCode members accessible", () => {
    expect(QRTrxCode.DynamicQRCode.value).toBe("DynamicQRCode");
  });
});

// ─── Section 8: Wire-trap spot-checks ────────────────────────────────────────

describe("Wire-trap annotations", () => {
  it("occassion uses double-s (intentional misspelling)", () => {
    const req: STKPushRequest = {
      businessShortCode: "174379",
      password: "MTc0...",
      timestamp: "20210628122408",
      transactionType: TransactionType.BillPayGoodsGoods,
      amount: 100,
      partyA: "254712345678",
      partyB: "254787654321",
      phoneNumber: "254712345678",
      callBackURL: "https://example.com/cb",
      accountReference: "ORD-1",
      transactionDesc: "test",
      occassion: "promo",
    };
    expect(req.occassion).toBe("promo");
  });

  it("ReversalRequest.recieverIdentifierType uses deliberate misspelling", () => {
    const req: ReversalRequest = {
      initiator: "test",
      securityCredential: "enc",
      commandID: CommandID.ReverseTransaction,
      transactionID: "TX1",
      receiverParty: "174379",
      recieverIdentifierType: "11",
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
    };
    expect(req.queueTimeOutURL).toBe("https://example.com/timeout");
  });
});

// ─── Section 9: MetadataItem compiles ────────────────────────────────────────

describe("MetadataItem compiles", () => {
  it("constructs with string and number values", () => {
    const item1: MetadataItem = { Name: "Amount", Value: 1000 };
    const item2: MetadataItem = { Name: "Receipt", Value: "QKH7BDX10S" };
    expect(item1.Value).toBe(1000);
    expect(item2.Value).toBe("QKH7BDX10S");
  });
});
