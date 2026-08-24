/**
 * Tests for src/client.ts — MpesaClient with all 9 endpoints, retry-once
 * auth, value semantics, and default injection.
 *
 * Mirrors go/client_test.go and python/mpesa/client.py test patterns
 * with exact parity on retry, generation-guard, and validation semantics.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MpesaClient, createClient, createClientFromEnv } from "../src/client.js";
import { Config, Environment } from "../src/config.js";
import { MpesaError } from "../src/errors.js";
import {
  TransactionType,
  CommandID,
  ResponseType,
  QRTrxCode,
} from "../src/enums.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const CONSUMER_KEY = "test-key";
const CONSUMER_SECRET = "test-secret";
const SHORTCODE = "174379";
const PASSKEY = "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";

const FIXED_CLOCK_MS = new Date("2021-06-28T09:24:08Z").getTime(); // EAT: 20210628122408

const VALID_TOKEN_RESPONSE = {
  access_token: "tok-abc123",
  expires_in: "3599",
  token_type: "Bearer",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(
  status: number,
  envelope: Record<string, unknown>,
): Response {
  return new Response(JSON.stringify(envelope), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function validSTKPushRequest() {
  return {
    transactionType: TransactionType.BillPayGoods,
    amount: 1,
    partyA: "254722000000",
    phoneNumber: "254722111111",
    callBackURL: "https://mydomain.com/path",
    accountReference: "accountref",
    transactionDesc: "txndesc",
  };
}

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

let fetchMock: ReturnType<typeof vi.fn>;
let nowMs: number;

beforeEach(() => {
  nowMs = FIXED_CLOCK_MS;
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeClient(baseURL: string): MpesaClient {
  return new MpesaClient({
    config: new Config({
      consumerKey: CONSUMER_KEY,
      consumerSecret: CONSUMER_SECRET,
      shortcode: SHORTCODE,
      passkey: PASSKEY,
      environment: Environment.SANDBOX,
    }),
    timeoutMs: 5000,
    now: () => nowMs,
  });
}

// Override baseURL after construction (matches Go testClient pattern)
function testClient(baseURL: string): MpesaClient {
  return new MpesaClient({
    config: new Config({
      consumerKey: CONSUMER_KEY,
      consumerSecret: CONSUMER_SECRET,
      shortcode: SHORTCODE,
      passkey: PASSKEY,
      environment: new Environment("sandbox", baseURL),
    }),
    timeoutMs: 5000,
    now: () => nowMs,
  });
}

// ---------------------------------------------------------------------------
// Construction & factory
// ---------------------------------------------------------------------------

describe("MpesaClient construction", () => {
  it("creates from config via factory", () => {
    const cfg = new Config({
      consumerKey: CONSUMER_KEY,
      consumerSecret: CONSUMER_SECRET,
      shortcode: SHORTCODE,
      passkey: PASSKEY,
    });
    const client = createClient(cfg);
    expect(client).toBeInstanceOf(MpesaClient);
  });

  it("creates from environment variables", () => {
    vi.stubEnv("MPESA_CONSUMER_KEY", "env-key");
    vi.stubEnv("MPESA_CONSUMER_SECRET", "env-secret");
    vi.stubEnv("MPESA_SHORTCODE", "12345");
    vi.stubEnv("MPESA_PASSKEY", "env-passkey");
    vi.stubEnv("MPESA_ENVIRONMENT", "sandbox");
    const client = createClientFromEnv();
    expect(client).toBeInstanceOf(MpesaClient);
  });

  it("toString is credential-safe", () => {
    const client = testClient("https://sandbox.safaricom.co.ke");
    const str = client.toString();
    expect(str).not.toContain(CONSUMER_KEY);
    expect(str).not.toContain(CONSUMER_SECRET);
    expect(str).toContain("sandbox");
  });

  it("toJSON is credential-safe", () => {
    const client = testClient("https://sandbox.safaricom.co.ke");
    const json = client.toJSON();
    expect(json).not.toContain(CONSUMER_KEY);
    expect(json).not.toContain(CONSUMER_SECRET);
    expect(json.environment).toBe("sandbox");
  });
});

// ---------------------------------------------------------------------------
// OAuth once across sequential calls
// ---------------------------------------------------------------------------

describe("OAuth called once across sequential business calls", () => {
  it("fetches token once and reuses it", async () => {
    let oauthHits = 0;
    let pushHits = 0;
    let queryHits = 0;

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/oauth/v1/generate") {
        oauthHits++;
        return jsonResponse(VALID_TOKEN_RESPONSE);
      }
      if (path === "/mpesa/stkpush/v1/processrequest") {
        pushHits++;
        return jsonResponse({
          MerchantRequestID: "mr-1",
          CheckoutRequestID: "ws_CO_1",
          ResponseCode: "0",
          ResponseDescription: "accepted",
          CustomerMessage: "ok",
        });
      }
      if (path === "/mpesa/stkpushquery/v1/query") {
        queryHits++;
        return jsonResponse({
          ResponseCode: "0",
          ResponseDescription: "desc",
          MerchantRequestID: "mr-1",
          CheckoutRequestID: "ws_CO_1",
          ResultCode: "1032",
          ResultDesc: "Request cancelled by user",
        });
      }
      return new Response("not found", { status: 404 });
    });

    const client = testClient("https://sandbox.safaricom.co.ke");

    const push = await client.stkPush(validSTKPushRequest());
    expect(push.CheckoutRequestID).toBe("ws_CO_1");

    const query = await client.stkQuery({
      checkoutRequestID: push.CheckoutRequestID,
    });
    expect(query.ResultCode).toBe("1032");

    expect(oauthHits).toBe(1);
    expect(pushHits).toBe(1);
    expect(queryHits).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// All endpoints hit documented paths with Bearer token
// ---------------------------------------------------------------------------

describe("All endpoints hit documented paths with Bearer", () => {
  it("each endpoint sends correct path, method, and Bearer token", async () => {
    let oauthHits = 0;
    const authByPath: Record<string, string> = {};
    const bodiesByPath: Record<string, string> = {};

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      const auth = init?.headers && typeof init.headers === "object"
        ? (init.headers as Record<string, string>)["Authorization"] ?? ""
        : "";

      if (path === "/oauth/v1/generate") {
        oauthHits++;
        return jsonResponse(VALID_TOKEN_RESPONSE);
      }

      // Record auth and body for business paths
      authByPath[path] = auth;
      if (init?.body) {
        bodiesByPath[path] = init.body as string;
      }

      // Return appropriate responses
      const conversationACK = {
        OriginatorConversationID: "o",
        ConversationID: "AG_1",
        ResponseCode: "0",
        ResponseDescription: "Accept the service request successfully.",
      };

      switch (path) {
        case "/mpesa/stkpush/v1/processrequest":
          return jsonResponse({
            MerchantRequestID: "mr",
            CheckoutRequestID: "ws_CO_x",
            ResponseCode: "0",
            ResponseDescription: "accepted",
            CustomerMessage: "Success. Request accepted for processing",
          });
        case "/mpesa/stkpushquery/v1/query":
          return jsonResponse({
            ResponseCode: "0",
            ResponseDescription: "desc",
            MerchantRequestID: "mr",
            CheckoutRequestID: "ws_CO_x",
            ResultCode: "0",
            ResultDesc: "processed",
          });
        case "/mpesa/b2c/v3/paymentrequest":
          return jsonResponse(conversationACK);
        case "/mpesa/c2b/v2/registerurl":
          return jsonResponse({
            OriginatorCoversationID: "53e3-coversation-misspelled",
            ResponseCode: "0",
            ResponseDescription: "Accept the service request successfully.",
          });
        case "/mpesa/c2b/v2/simulate":
          return jsonResponse({
            OriginatorCoversationID: "sim-ack",
            ResponseCode: "0",
            ResponseDescription: "Accept the service request successfully.",
          });
        case "/mpesa/transactionstatus/v1/query":
          return jsonResponse(conversationACK);
        case "/mpesa/reversal/v1/request":
          return jsonResponse(conversationACK);
        case "/mpesa/accountbalance/v1/query":
          return jsonResponse(conversationACK);
        case "/mpesa/qrcode/v1/generate":
          return jsonResponse({
            ResponseCode: "AG_20191219_000043fdf6",
            RequestID: "16738-27456357-1",
            ResponseDescription: "QR Code Successfully Generated",
            QRCode: "qrpayload",
          });
        default:
          return new Response("not found", { status: 404 });
      }
    });

    const client = testClient("https://sandbox.safaricom.co.ke");

    // STK Push
    const stkPushResp = await client.stkPush(validSTKPushRequest());
    expect(stkPushResp.ResponseCode).toBe("0");
    expect(stkPushResp.CustomerMessage).toBeTruthy();

    // STK Query
    await client.stkQuery({ checkoutRequestID: "ws_CO_x" });

    // B2C Payout
    const b2cResp = await client.b2cPayout({
      initiatorName: "testapi",
      securityCredential: "x".repeat(344),
      commandID: CommandID.BusinessPayment,
      amount: 100,
      partyA: "600992",
      partyB: "254705912645",
      remarks: "refund order 42",
      queueTimeOutURL: "https://mydomain.com/timeout",
      resultURL: "https://mydomain.com/result",
    });
    expect(b2cResp.ConversationID).toBe("AG_1");

    // C2B Register
    const regAck = await client.c2bRegisterURL({
      responseType: ResponseType.Success,
      confirmationURL: "https://mydomain.com/c2b/confirmation",
      validationURL: "https://mydomain.com/c2b/validation",
    });
    expect(regAck.OriginatorCoversationID).toBe("53e3-coversation-misspelled");

    // C2B Simulate
    await client.c2bSimulate({
      commandID: CommandID.PayBill,
      amount: 10,
      msisdn: "0712345678",
      billRefNumber: "acct-1",
    });

    // Transaction Status
    await client.transactionStatus({
      initiator: "testapi",
      securityCredential: "cred",
      transactionID: "NLJ7RT61SV",
      partyA: "600992",
      remarks: "reconcile",
      resultURL: "https://mydomain.com/result",
      queueTimeOutURL: "https://mydomain.com/timeout",
    });

    // Reversal
    await client.reversal({
      initiator: "testapi",
      securityCredential: "cred",
      transactionID: "NLJ7RT61SV",
      amount: 100,
      receiverParty: "600992",
      remarks: "wrong deposit",
      resultURL: "https://mydomain.com/result",
      queueTimeOutURL: "https://mydomain.com/timeout",
    });

    // Account Balance
    await client.accountBalance({
      initiator: "testapi",
      securityCredential: "cred",
      partyA: "600992",
      remarks: "eod balance",
      resultURL: "https://mydomain.com/result",
      queueTimeOutURL: "https://mydomain.com/timeout",
    });

    // QR Code
    const qr = await client.generateQRCode({
      merchantName: "TEST SUPERMARKET",
      refNo: "Invoice Test",
      amount: 1,
      trxCode: QRTrxCode.DynamicQRCode,
      cpi: "174379",
      size: "300",
    });
    expect(qr.QRCode).toBe("qrpayload");
    expect(qr.RequestID).toBe("16738-27456357-1");

    // Verify all paths got Bearer token
    const businessPaths = [
      "/mpesa/stkpush/v1/processrequest",
      "/mpesa/stkpushquery/v1/query",
      "/mpesa/b2c/v3/paymentrequest",
      "/mpesa/c2b/v2/registerurl",
      "/mpesa/c2b/v2/simulate",
      "/mpesa/transactionstatus/v1/query",
      "/mpesa/reversal/v1/request",
      "/mpesa/accountbalance/v1/query",
      "/mpesa/qrcode/v1/generate",
    ];
    for (const path of businessPaths) {
      expect(authByPath[path]).toBe("Bearer tok-abc123");
    }
    expect(oauthHits).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Default injection tests
// ---------------------------------------------------------------------------

describe("Default injection", () => {
  it("B2C: auto-generates OriginatorConversationID, PartyA defaults to shortcode", async () => {
    let capturedBody: Record<string, unknown> = {};

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/oauth/v1/generate") {
        return jsonResponse(VALID_TOKEN_RESPONSE);
      }
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string);
      }
      return jsonResponse({
        OriginatorConversationID: "o",
        ConversationID: "AG_1",
        ResponseCode: "0",
        ResponseDescription: "ok",
      });
    });

    const client = testClient("https://sandbox.safaricom.co.ke");
    await client.b2cPayout({
      initiatorName: "testapi",
      securityCredential: "cred",
      commandID: CommandID.BusinessPayment,
      amount: 100,
      partyA: "", // should default to shortcode
      partyB: "254705912645",
      remarks: "refund",
      queueTimeOutURL: "https://a.com/t",
      resultURL: "https://a.com/r",
    });

    // PartyA should default to config shortcode
    expect(capturedBody["PartyA"]).toBe(SHORTCODE);
    // OriginatorConversationID should be auto-generated (16 hex chars)
    const ocid = capturedBody["OriginatorConversationID"] as string;
    expect(ocid.length).toBeGreaterThan(0);
    expect(ocid.length).toBeLessThanOrEqual(20);
    expect(/^[0-9a-f]+$/.test(ocid)).toBe(true);
  });

  it("TransactionStatus: CommandID and IdentifierType defaults", async () => {
    let capturedBody: Record<string, unknown> = {};

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/oauth/v1/generate") {
        return jsonResponse(VALID_TOKEN_RESPONSE);
      }
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string);
      }
      return jsonResponse({
        OriginatorConversationID: "o",
        ConversationID: "AG_1",
        ResponseCode: "0",
        ResponseDescription: "ok",
      });
    });

    const client = testClient("https://sandbox.safaricom.co.ke");
    await client.transactionStatus({
      initiator: "testapi",
      securityCredential: "cred",
      transactionID: "NLJ7RT61SV",
      partyA: "600992",
      remarks: "reconcile",
      resultURL: "https://a.com/r",
      queueTimeOutURL: "https://a.com/t",
    });

    expect(capturedBody["CommandID"]).toBe(CommandID.TransactionStatusQuery.value);
    expect(capturedBody["IdentifierType"]).toBe("4");
  });

  it("Reversal: CommandID and RecieverIdentifierType defaults", async () => {
    let capturedBody: Record<string, unknown> = {};

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/oauth/v1/generate") {
        return jsonResponse(VALID_TOKEN_RESPONSE);
      }
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string);
      }
      return jsonResponse({
        OriginatorConversationID: "o",
        ConversationID: "AG_1",
        ResponseCode: "0",
        ResponseDescription: "ok",
      });
    });

    const client = testClient("https://sandbox.safaricom.co.ke");
    await client.reversal({
      initiator: "testapi",
      securityCredential: "cred",
      transactionID: "NLJ7RT61SV",
      amount: 100,
      receiverParty: "600992",
      remarks: "wrong deposit",
      resultURL: "https://a.com/r",
      queueTimeOutURL: "https://a.com/t",
    });

    expect(capturedBody["CommandID"]).toBe(CommandID.ReverseTransaction.value);
    expect(capturedBody["RecieverIdentifierType"]).toBe("11");
  });

  it("AccountBalance: CommandID and IdentifierType defaults", async () => {
    let capturedBody: Record<string, unknown> = {};

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/oauth/v1/generate") {
        return jsonResponse(VALID_TOKEN_RESPONSE);
      }
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string);
      }
      return jsonResponse({
        OriginatorConversationID: "o",
        ConversationID: "AG_1",
        ResponseCode: "0",
        ResponseDescription: "ok",
      });
    });

    const client = testClient("https://sandbox.safaricom.co.ke");
    await client.accountBalance({
      initiator: "testapi",
      securityCredential: "cred",
      partyA: "600992",
      remarks: "eod",
      resultURL: "https://a.com/r",
      queueTimeOutURL: "https://a.com/t",
    });

    expect(capturedBody["CommandID"]).toBe(CommandID.AccountBalance.value);
    expect(capturedBody["IdentifierType"]).toBe("4");
  });

  it("STK Push: PartyB defaults to BusinessShortCode", async () => {
    let capturedBody: Record<string, unknown> = {};

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/oauth/v1/generate") {
        return jsonResponse(VALID_TOKEN_RESPONSE);
      }
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string);
      }
      return jsonResponse({
        MerchantRequestID: "mr",
        CheckoutRequestID: "ws_CO_1",
        ResponseCode: "0",
        ResponseDescription: "ok",
        CustomerMessage: "ok",
      });
    });

    const client = testClient("https://sandbox.safaricom.co.ke");

    // Without PartyB — should default to shortcode
    await client.stkPush({
      ...validSTKPushRequest(),
      partyB: "",
    });
    expect(capturedBody["PartyB"]).toBe(SHORTCODE);

    // With explicit PartyB — should pass through
    await client.stkPush({
      ...validSTKPushRequest(),
      partyB: "999777",
    });
    expect(capturedBody["PartyB"]).toBe("999777");
  });

  it("C2B Register: ShortCode defaults to config shortcode", async () => {
    let capturedBody: Record<string, unknown> = {};

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/oauth/v1/generate") {
        return jsonResponse(VALID_TOKEN_RESPONSE);
      }
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string);
      }
      return jsonResponse({
        OriginatorCoversationID: "ack",
        ResponseCode: "0",
        ResponseDescription: "ok",
      });
    });

    const client = testClient("https://sandbox.safaricom.co.ke");
    await client.c2bRegisterURL({
      responseType: ResponseType.Success,
      confirmationURL: "https://a.com/c",
      validationURL: "https://a.com/v",
    });

    expect(capturedBody["ShortCode"]).toBe(SHORTCODE);
  });

  it("C2B Simulate: ShortCode defaults to config shortcode", async () => {
    let capturedBody: Record<string, unknown> = {};

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/oauth/v1/generate") {
        return jsonResponse(VALID_TOKEN_RESPONSE);
      }
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string);
      }
      return jsonResponse({
        OriginatorCoversationID: "ack",
        ResponseCode: "0",
        ResponseDescription: "ok",
      });
    });

    const client = testClient("https://sandbox.safaricom.co.ke");
    await client.c2bSimulate({
      commandID: CommandID.PayBill,
      amount: 10,
      msisdn: "0712345678",
      billRefNumber: "acct-1",
    });

    expect(capturedBody["ShortCode"]).toBe(SHORTCODE);
    // Msisdn should be normalized
    expect(capturedBody["Msisdn"]).toBe("254712345678");
  });
});

// ---------------------------------------------------------------------------
// Password binding test (single clock)
// ---------------------------------------------------------------------------

describe("Password binding (single clock)", () => {
  it("STK Push: password binds to body timestamp and effective shortcode", async () => {
    let capturedBody: Record<string, unknown> = {};

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/oauth/v1/generate") {
        return jsonResponse(VALID_TOKEN_RESPONSE);
      }
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string);
      }
      return jsonResponse({
        MerchantRequestID: "mr",
        CheckoutRequestID: "ws_CO_1",
        ResponseCode: "0",
        ResponseDescription: "ok",
        CustomerMessage: "ok",
      });
    });

    const client = testClient("https://sandbox.safaricom.co.ke");
    await client.stkPush(validSTKPushRequest());

    // Timestamp should be EAT rendering of fixed clock
    expect(capturedBody["Timestamp"]).toBe("20210628122408");

    // Password should be base64(shortcode + passkey + timestamp)
    const ts = capturedBody["Timestamp"] as string;
    const expectedPassword = Buffer.from(SHORTCODE + PASSKEY + ts, "utf-8").toString("base64");
    expect(capturedBody["Password"]).toBe(expectedPassword);

    // BusinessShortCode should be the config shortcode
    expect(capturedBody["BusinessShortCode"]).toBe(SHORTCODE);
  });

  it("STK Query: password binds to effective shortcode (override)", async () => {
    let capturedBody: Record<string, unknown> = {};

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/oauth/v1/generate") {
        return jsonResponse(VALID_TOKEN_RESPONSE);
      }
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string);
      }
      return jsonResponse({
        ResponseCode: "0",
        ResponseDescription: "desc",
        MerchantRequestID: "mr",
        CheckoutRequestID: "ws_CO_x",
        ResultCode: "0",
        ResultDesc: "processed",
      });
    });

    const client = testClient("https://sandbox.safaricom.co.ke");

    // With override shortcode
    await client.stkQuery({
      businessShortCode: "999888",
      checkoutRequestID: "ws_CO_override",
    });

    const ts = capturedBody["Timestamp"] as string;
    const expectedPassword = Buffer.from("999888" + PASSKEY + ts, "utf-8").toString("base64");
    expect(capturedBody["Password"]).toBe(expectedPassword);
    expect(capturedBody["BusinessShortCode"]).toBe("999888");
  });

  it("STK Query: password binds to config shortcode (default)", async () => {
    let capturedBody: Record<string, unknown> = {};

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/oauth/v1/generate") {
        return jsonResponse(VALID_TOKEN_RESPONSE);
      }
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string);
      }
      return jsonResponse({
        ResponseCode: "0",
        ResponseDescription: "desc",
        MerchantRequestID: "mr",
        CheckoutRequestID: "ws_CO_x",
        ResultCode: "0",
        ResultDesc: "processed",
      });
    });

    const client = testClient("https://sandbox.safaricom.co.ke");

    // Without override — uses config shortcode
    await client.stkQuery({
      checkoutRequestID: "ws_CO_default",
    });

    const ts = capturedBody["Timestamp"] as string;
    const expectedPassword = Buffer.from(SHORTCODE + PASSKEY + ts, "utf-8").toString("base64");
    expect(capturedBody["Password"]).toBe(expectedPassword);
    expect(capturedBody["BusinessShortCode"]).toBe(SHORTCODE);
  });
});

// ---------------------------------------------------------------------------
// Value semantics — caller's object is never mutated
// ---------------------------------------------------------------------------

describe("Value semantics", () => {
  it("STK Push: caller's request is not mutated", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/oauth/v1/generate") {
        return jsonResponse(VALID_TOKEN_RESPONSE);
      }
      return jsonResponse({
        MerchantRequestID: "mr",
        CheckoutRequestID: "ws_CO_1",
        ResponseCode: "0",
        ResponseDescription: "ok",
        CustomerMessage: "ok",
      });
    });

    const client = testClient("https://sandbox.safaricom.co.ke");
    const req = {
      transactionType: TransactionType.BillPayGoods,
      amount: 100,
      partyA: "254722000000",
      partyB: "",
      phoneNumber: "254722111111",
      callBackURL: "https://mydomain.com/callback",
      accountReference: "Order123",
      transactionDesc: "Payment",
    };

    // Snapshot before
    const before = { ...req };

    await client.stkPush(req);

    // Should be unchanged — client applies defaults to internal copy
    expect(req.partyB).toBe(before.partyB);
    expect(req.amount).toBe(before.amount);
  });

  it("B2C: caller's request is not mutated", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/oauth/v1/generate") {
        return jsonResponse(VALID_TOKEN_RESPONSE);
      }
      return jsonResponse({
        OriginatorConversationID: "o",
        ConversationID: "AG_1",
        ResponseCode: "0",
        ResponseDescription: "ok",
      });
    });

    const client = testClient("https://sandbox.safaricom.co.ke");
    const req = {
      initiatorName: "testapi",
      securityCredential: "cred",
      commandID: CommandID.BusinessPayment,
      amount: 100,
      partyA: "",
      partyB: "254705912645",
      remarks: "refund",
      queueTimeOutURL: "https://a.com/t",
      resultURL: "https://a.com/r",
    };

    const before = { ...req };
    await client.b2cPayout(req);

    // partyA should still be empty in caller's object
    expect(req.partyA).toBe(before.partyA);
  });
});

// ---------------------------------------------------------------------------
// 401 retry-once
// ---------------------------------------------------------------------------

describe("401 retry-once", () => {
  it("retries once on 401.003.01 and succeeds", async () => {
    let pushHits = 0;
    let oauthHits = 0;

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/oauth/v1/generate") {
        oauthHits++;
        return jsonResponse(VALID_TOKEN_RESPONSE);
      }
      if (path === "/mpesa/stkpush/v1/processrequest") {
        pushHits++;
        if (pushHits === 1) {
          return errorResponse(401, {
            errorCode: "401.003.01",
            errorMessage: "Invalid access token",
          });
        }
        return jsonResponse({
          MerchantRequestID: "mr",
          CheckoutRequestID: "ws_CO_retry",
          ResponseCode: "0",
          ResponseDescription: "ok",
          CustomerMessage: "ok",
        });
      }
      return new Response("not found", { status: 404 });
    });

    const client = testClient("https://sandbox.safaricom.co.ke");
    const resp = await client.stkPush(validSTKPushRequest());

    expect(resp.CheckoutRequestID).toBe("ws_CO_retry");
    expect(pushHits).toBe(2);
    expect(oauthHits).toBe(2); // initial + forced refresh
  });

  it("does NOT retry on 401 without 401.003.01 error code", async () => {
    let pushHits = 0;
    let oauthHits = 0;

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/oauth/v1/generate") {
        oauthHits++;
        return jsonResponse(VALID_TOKEN_RESPONSE);
      }
      if (path === "/mpesa/stkpush/v1/processrequest") {
        pushHits++;
        return errorResponse(401, {
          errorCode: "500.001.1001",
          errorMessage: "wrong credentials",
        });
      }
      return new Response("not found", { status: 404 });
    });

    const client = testClient("https://sandbox.safaricom.co.ke");

    try {
      await client.stkPush(validSTKPushRequest());
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MpesaError);
      expect((err as MpesaError).statusCode).toBe(401);
    }

    expect(pushHits).toBe(1);
    expect(oauthHits).toBe(1); // no retry
  });

  it("surfaces typed error when retry also fails with 401.003.01", async () => {
    let pushHits = 0;
    let oauthHits = 0;

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/oauth/v1/generate") {
        oauthHits++;
        return jsonResponse({
          access_token: `tok-${oauthHits}`,
          expires_in: "3599",
          token_type: "Bearer",
        });
      }
      if (path === "/mpesa/stkpush/v1/processrequest") {
        pushHits++;
        return errorResponse(401, {
          errorCode: "401.003.01",
          errorMessage: "still invalid",
        });
      }
      return new Response("not found", { status: 404 });
    });

    const client = testClient("https://sandbox.safaricom.co.ke");

    try {
      await client.stkPush(validSTKPushRequest());
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MpesaError);
      expect((err as MpesaError).statusCode).toBe(401);
    }

    expect(pushHits).toBe(2);
    expect(oauthHits).toBe(2);
  });

  it("handles 401 with HTML body (non-JSON)", async () => {
    let pushHits = 0;

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/oauth/v1/generate") {
        return jsonResponse(VALID_TOKEN_RESPONSE);
      }
      if (path === "/mpesa/stkpush/v1/processrequest") {
        pushHits++;
        return new Response("<html>blocked</html>", {
          status: 401,
          headers: { "Content-Type": "text/html" },
        });
      }
      return new Response("not found", { status: 404 });
    });

    const client = testClient("https://sandbox.safaricom.co.ke");

    try {
      await client.stkPush(validSTKPushRequest());
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MpesaError);
      expect((err as MpesaError).statusCode).toBe(401);
    }

    // 401 with HTML body is not retryable (no 401.003.01 errorCode)
    expect(pushHits).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Error envelope parsing
// ---------------------------------------------------------------------------

describe("Error envelope", () => {
  it("parses Daraja error envelope into typed MpesaError", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/oauth/v1/generate") {
        return jsonResponse(VALID_TOKEN_RESPONSE);
      }
      return errorResponse(400, {
        requestId: "27504-4b64-1",
        errorCode: "400.002.02",
        errorMessage: "Bad Request - Invalid BusinessShortCode",
      });
    });

    const client = testClient("https://sandbox.safaricom.co.ke");

    try {
      await client.stkPush(validSTKPushRequest());
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MpesaError);
      const mpesaErr = err as MpesaError;
      expect(mpesaErr.statusCode).toBe(400);
      expect(mpesaErr.errorCode).toBe("400.002.02");
      expect(mpesaErr.errorMessage).toBe("Bad Request - Invalid BusinessShortCode");
      expect(mpesaErr.requestId).toBe("27504-4b64-1");
    }
  });

  it("handles unparseable body with diagnostic", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/oauth/v1/generate") {
        return jsonResponse(VALID_TOKEN_RESPONSE);
      }
      return new Response("<html>blocked by WAF</html>", {
        status: 403,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    });

    const client = testClient("https://sandbox.safaricom.co.ke");

    try {
      await client.accountBalance({
        initiator: "testapi",
        securityCredential: "cred",
        partyA: "600992",
        remarks: "eod",
        resultURL: "https://a.com/r",
        queueTimeOutURL: "https://a.com/t",
      });
      expect.fail("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(MpesaError);
      const msg = (err as MpesaError).message;
      expect(msg).toContain("text/html");
      expect(msg).toContain("bytes");
      expect(msg).toContain("blocked by WAF");
    }
  });
});

// ---------------------------------------------------------------------------
// Validation before network
// ---------------------------------------------------------------------------

describe("Validation before network", () => {
  it("validates all fields without touching network", async () => {
    let networkTouched = false;
    fetchMock.mockImplementation(async () => {
      networkTouched = true;
      return new Response("should not reach", { status: 500 });
    });

    const client = testClient("https://sandbox.safaricom.co.ke");

    const cases: Array<{ name: string; call: () => Promise<unknown>; want: string }> = [
      {
        name: "stk amount zero",
        call: () => client.stkPush({ ...validSTKPushRequest(), amount: 0 }),
        want: "Amount",
      },
      {
        name: "stk negative amount",
        call: () => client.stkPush({ ...validSTKPushRequest(), amount: -5 }),
        want: "Amount",
      },
      {
        name: "stk account reference too long",
        call: () => client.stkPush({ ...validSTKPushRequest(), accountReference: "thirteen-chars" }),
        want: "AccountReference",
      },
      {
        name: "stk description too long",
        call: () => client.stkPush({ ...validSTKPushRequest(), transactionDesc: "fourteen chars!" }),
        want: "TransactionDesc",
      },
      {
        name: "stk bad phone",
        call: () => client.stkPush({ ...validSTKPushRequest(), phoneNumber: "07123" }),
        want: "MSISDN",
      },
      {
        name: "stk missing transaction type",
        call: () => client.stkPush({ ...validSTKPushRequest(), transactionType: undefined as any }),
        want: "TransactionType is required",
      },
      {
        name: "b2c remarks too short",
        call: () => client.b2cPayout({
          initiatorName: "i", securityCredential: "c", commandID: CommandID.BusinessPayment,
          amount: 500, partyA: "600992", partyB: "254705912645", remarks: "x",
          queueTimeOutURL: "https://a.com/t", resultURL: "https://a.com/r",
        }),
        want: "Remarks",
      },
      {
        name: "b2c remarks too long",
        call: () => client.b2cPayout({
          initiatorName: "i", securityCredential: "c", commandID: CommandID.BusinessPayment,
          amount: 500, partyA: "600992", partyB: "254705912645", remarks: "r".repeat(101),
          queueTimeOutURL: "https://a.com/t", resultURL: "https://a.com/r",
        }),
        want: "Remarks",
      },
      {
        name: "b2c amount below minimum",
        call: () => client.b2cPayout({
          initiatorName: "i", securityCredential: "c", commandID: CommandID.BusinessPayment,
          amount: 9, partyA: "600992", partyB: "254705912645", remarks: "ok",
          queueTimeOutURL: "https://a.com/t", resultURL: "https://a.com/r",
        }),
        want: "Amount",
      },
      {
        name: "b2c amount above maximum",
        call: () => client.b2cPayout({
          initiatorName: "i", securityCredential: "c", commandID: CommandID.BusinessPayment,
          amount: 250001, partyA: "600992", partyB: "254705912645", remarks: "ok",
          queueTimeOutURL: "https://a.com/t", resultURL: "https://a.com/r",
        }),
        want: "Amount",
      },
      {
        name: "txstatus both identifiers",
        call: () => client.transactionStatus({
          initiator: "i", securityCredential: "c", transactionID: "R1",
          originalConversationID: "o-1", partyA: "600992", remarks: "ok",
          resultURL: "https://a.com/r", queueTimeOutURL: "https://a.com/t",
        }),
        want: "exactly one",
      },
      {
        name: "txstatus neither identifier",
        call: () => client.transactionStatus({
          initiator: "i", securityCredential: "c", partyA: "600992",
          remarks: "ok", resultURL: "https://a.com/r", queueTimeOutURL: "https://a.com/t",
        }),
        want: "exactly one",
      },
      {
        name: "reversal remarks too short",
        call: () => client.reversal({
          initiator: "i", securityCredential: "c", transactionID: "R1",
          amount: 10, receiverParty: "600992", remarks: "",
          resultURL: "https://a.com/r", queueTimeOutURL: "https://a.com/t",
        }),
        want: "Remarks",
      },
      {
        name: "qr zero amount",
        call: () => client.generateQRCode({
          merchantName: "m", refNo: "ref", amount: 0,
          trxCode: QRTrxCode.DynamicQRCode, cpi: "174379", size: "300",
        }),
        want: "Amount",
      },
      {
        name: "simulate paybill without bill ref",
        call: () => client.c2bSimulate({
          commandID: CommandID.PayBill, amount: 5, msisdn: "0712345678",
        }),
        want: "BillRefNumber",
      },
    ];

    for (const tc of cases) {
      await expect(tc.call()).rejects.toThrow(tc.want);
    }

    expect(networkTouched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// C2B Register URL response type mapping
// ---------------------------------------------------------------------------

describe("C2B Register URL", () => {
  it("maps ResponseType.Success to Completed on wire", async () => {
    let capturedBody: Record<string, unknown> = {};

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/oauth/v1/generate") {
        return jsonResponse(VALID_TOKEN_RESPONSE);
      }
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string);
      }
      return jsonResponse({
        OriginatorCoversationID: "ack",
        ResponseCode: "0",
        ResponseDescription: "ok",
      });
    });

    const client = testClient("https://sandbox.safaricom.co.ke");
    await client.c2bRegisterURL({
      responseType: ResponseType.Success,
      confirmationURL: "https://a.com/c",
      validationURL: "https://a.com/v",
    });

    expect(capturedBody["ResponseType"]).toBe("Completed");
  });

  it("maps ResponseType.Fail to Cancelled on wire", async () => {
    let capturedBody: Record<string, unknown> = {};

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/oauth/v1/generate") {
        return jsonResponse(VALID_TOKEN_RESPONSE);
      }
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string);
      }
      return jsonResponse({
        OriginatorCoversationID: "ack",
        ResponseCode: "0",
        ResponseDescription: "ok",
      });
    });

    const client = testClient("https://sandbox.safaricom.co.ke");
    await client.c2bRegisterURL({
      responseType: ResponseType.Fail,
      confirmationURL: "https://a.com/c",
      validationURL: "https://a.com/v",
    });

    expect(capturedBody["ResponseType"]).toBe("Cancelled");
  });
});

// ---------------------------------------------------------------------------
// C2B Simulate Msisdn normalization
// ---------------------------------------------------------------------------

describe("C2B Simulate", () => {
  it("normalizes Msisdn to gateway form", async () => {
    let capturedBody: Record<string, unknown> = {};

    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/oauth/v1/generate") {
        return jsonResponse(VALID_TOKEN_RESPONSE);
      }
      if (init?.body) {
        capturedBody = JSON.parse(init.body as string);
      }
      return jsonResponse({
        OriginatorCoversationID: "ack",
        ResponseCode: "0",
        ResponseDescription: "ok",
      });
    });

    const client = testClient("https://sandbox.safaricom.co.ke");
    await client.c2bSimulate({
      commandID: CommandID.PayBill,
      amount: 10,
      msisdn: "0712345678",
      billRefNumber: "acct-1",
    });

    expect(capturedBody["Msisdn"]).toBe("254712345678");
  });
});

// ---------------------------------------------------------------------------
// QR Code validation
// ---------------------------------------------------------------------------

describe("QR Code validation", () => {
  it("rejects invalid CPI (non-digits)", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(VALID_TOKEN_RESPONSE));

    const client = testClient("https://sandbox.safaricom.co.ke");

    await expect(
      client.generateQRCode({
        merchantName: "m",
        refNo: "ref",
        amount: 1,
        trxCode: QRTrxCode.DynamicQRCode,
        cpi: "abc12",
        size: "300",
      }),
    ).rejects.toThrow("CPI");
  });

  it("rejects CPI too short", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(VALID_TOKEN_RESPONSE));

    const client = testClient("https://sandbox.safaricom.co.ke");

    await expect(
      client.generateQRCode({
        merchantName: "m",
        refNo: "ref",
        amount: 1,
        trxCode: QRTrxCode.DynamicQRCode,
        cpi: "1234",
        size: "300",
      }),
    ).rejects.toThrow("CPI");
  });

  it("rejects negative size", async () => {
    fetchMock.mockImplementation(async () => jsonResponse(VALID_TOKEN_RESPONSE));

    const client = testClient("https://sandbox.safaricom.co.ke");

    await expect(
      client.generateQRCode({
        merchantName: "m",
        refNo: "ref",
        amount: 1,
        trxCode: QRTrxCode.DynamicQRCode,
        cpi: "174379",
        size: "-1",
      }),
    ).rejects.toThrow("Size");
  });
});
