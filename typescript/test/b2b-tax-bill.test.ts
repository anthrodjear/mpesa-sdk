/**
 * Tests for the three NEW endpoint families in src/client.ts — B2B Express
 * Checkout, Tax Remittance and Bill Manager (register/query/update/delete).
 *
 * Mirrors the fetchMock style of client.test.ts and the transport/business
 * separation of limits.test.ts. Covers, per endpoint:
 *   - happy path: exact wire path, exact body keys, Bearer authorization
 *   - validation BEFORE any network I/O (bad CommandID / shortcode shape /
 *     missing field)
 *   - default injection on an internal copy (caller's object is untouched)
 *   - the per-transaction ceiling gate (and the transport-only rollback)
 *
 * Wire contract: docs/apis/b2b.md, docs/apis/tax-remittance.md and
 * docs/apis/bill-manager.md — key CASING is contractual.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MpesaClient } from "../src/client.js";
import { Config, Environment } from "../src/config.js";
import { CommandID } from "../src/enums.js";
import { logSafeRequest } from "../src/helpers.js";
import { MpesaError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CONSUMER_KEY = "test-key";
const CONSUMER_SECRET = "test-secret";
const SHORTCODE = "174379";
const PASSKEY = "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";

const VALID_TOKEN_RESPONSE = {
  access_token: "tok-abc123",
  expires_in: "3599",
  token_type: "Bearer",
};

/** The queue-ACK shape shared by B2B and Tax Remittance. */
const CONVERSATION_ACK = {
  OriginatorConversationID: "o",
  ConversationID: "AG_1",
  ResponseCode: "0",
  ResponseDescription: "Accept the service request successfully.",
};

/** The ACK shape shared by all four Bill Manager endpoints. */
const BILL_ACK_WITH_REF = {
  ResponseCode: "0",
  ResponseDescription: "Accept the service request successfully.",
  ConversationID: "AG_2",
  OriginatorConversationID: "o-bill",
  BillRefNumber: "INV-001",
};

/** BillRefNumber is OPTIONAL on the wire (query/update/delete captures). */
const BILL_ACK_WITHOUT_REF = {
  ResponseCode: "0",
  ResponseDescription: "Accept the service request successfully.",
  ConversationID: "AG_2",
  OriginatorConversationID: "o-bill",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;
let nowMs: number;

beforeEach(() => {
  nowMs = new Date("2021-06-28T09:24:08Z").getTime();
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeClient(opts?: {
  limits?: Record<string, { maxPerTransaction?: number; maxPerDay?: number }>;
  trackDaily?: boolean;
}): MpesaClient {
  return new MpesaClient({
    config: new Config({
      consumerKey: CONSUMER_KEY,
      consumerSecret: CONSUMER_SECRET,
      shortcode: SHORTCODE,
      passkey: PASSKEY,
      environment: Environment.SANDBOX,
      ...(opts?.limits !== undefined && { limits: opts.limits }),
      ...(opts?.trackDaily !== undefined && { trackDaily: opts?.trackDaily }),
    }),
    timeoutMs: 5000,
    now: () => nowMs,
  });
}

/**
 * Route every business path to `bodyFor`, record the last business
 * (URL, body), and return the OAuth token on the OAuth leg.
 */
function mockTransport(
  bodyFor: (path: string) => Record<string, unknown> = () => CONVERSATION_ACK,
): { path: string; body: Record<string, unknown>; auth: string }[] {
  const seen: { path: string; body: Record<string, unknown>; auth: string }[] = [];
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/oauth/v1/generate") return jsonResponse(VALID_TOKEN_RESPONSE);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const body = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : {};
    seen.push({ path, body, auth: headers["Authorization"] ?? "" });
    return jsonResponse(bodyFor(path));
  });
  return seen;
}

/** Mock that FAILS the transport on the business leg (fetch throws). */
function mockTransportFailure(): void {
  fetchMock.mockImplementation(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/oauth/v1/generate") return jsonResponse(VALID_TOKEN_RESPONSE);
    throw new TypeError("fetch failed");
  });
}

/** Mock that answers the business leg with a 400 Daraja error envelope. */
function mockGatewayError(): void {
  fetchMock.mockImplementation(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === "/oauth/v1/generate") return jsonResponse(VALID_TOKEN_RESPONSE);
    return jsonResponse(
      { errorCode: "400.000.01", errorMessage: "bad", requestID: "r", conversationID: "c" },
      400,
    );
  });
}

// ---------------------------------------------------------------------------
// Request fixtures
// ---------------------------------------------------------------------------

function b2bReq(overrides: Record<string, unknown> = {}) {
  return {
    initiator: "testapi",
    securityCredential: "cred-b2b",
    commandID: CommandID.BusinessPayBill,
    amount: 1000,
    partyA: "600000",
    partyB: "600123",
    accountReference: "INV-001",
    remarks: "services",
    queueTimeOutURL: "https://mydomain.com/timeout",
    resultURL: "https://mydomain.com/result",
    ...overrides,
  };
}

function taxReq(overrides: Record<string, unknown> = {}) {
  return {
    ...b2bReq(),
    commandID: CommandID.TaxRemittance,
    accountReference: "TAX-2024-Q3",
    remarks: "VAT Q3 2024",
    partyB: "572700",
    taxPeriod: "2024Q3",
    taxObligation: "VAT",
    taxPayerPIN: "A001234567X",
    ...overrides,
  };
}

function billRegisterReq(overrides: Record<string, unknown> = {}) {
  return {
    shortCode: "600000",
    billRefNumber: "INV-001",
    billName: "Invoice 001",
    amount: 1000,
    expiryDate: "2024-12-31",
    callBackURL: "https://mydomain.com/bill",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// B2B Express Checkout
// ---------------------------------------------------------------------------

describe("B2B Express Checkout", () => {
  it("POSTs /mpesa/b2b/v3/paymentrequest with Bearer and the exact wire body", async () => {
    const seen = mockTransport();

    const ack = await makeClient().b2bPayment(
      b2bReq({ originatorConversationID: "b2b-ocid-0001" }),
    );

    expect(ack.ConversationID).toBe("AG_1");
    expect(ack.ResponseCode).toBe("0");

    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call?.path).toBe("/mpesa/b2b/v3/paymentrequest");
    expect(call?.auth).toBe("Bearer tok-abc123");
    expect(call?.body).toEqual({
      OriginatorConversationID: "b2b-ocid-0001",
      Initiator: "testapi",
      SecurityCredential: "cred-b2b",
      CommandID: "BusinessPayBill",
      SenderIdentifierType: "4",
      ReceiverIdentifierType: "4",
      Amount: 1000,
      PartyA: "600000",
      PartyB: "600123",
      AccountReference: "INV-001",
      Remarks: "services",
      QueueTimeOutURL: "https://mydomain.com/timeout",
      ResultURL: "https://mydomain.com/result",
    });
  });

  it("accepts exactly the two documented commands, both on the same path", async () => {
    const seen = mockTransport();
    const client = makeClient();

    for (const cmd of [CommandID.BusinessPayBill, CommandID.BusinessBuyGoods]) {
      await client.b2bPayment(b2bReq({ commandID: cmd }));
    }

    expect(seen).toHaveLength(2);
    expect(seen[0]?.body["CommandID"]).toBe("BusinessPayBill");
    expect(seen[1]?.body["CommandID"]).toBe("BusinessBuyGoods");
    expect(seen.every((s) => s.path === "/mpesa/b2b/v3/paymentrequest")).toBe(true);
  });

  it("injects defaults (OriginatorConversationID, both identifier types) on an internal copy", async () => {
    const seen = mockTransport();
    const req = b2bReq();
    delete (req as Record<string, unknown>).originatorConversationID;

    await makeClient().b2bPayment(req);

    const body = seen[0]?.body ?? {};
    // Identifier types default to "4" (organization shortcode)
    expect(body["SenderIdentifierType"]).toBe("4");
    expect(body["ReceiverIdentifierType"]).toBe("4");
    // OriginatorConversationID is auto-generated: 16 lowercase hex, ≤20
    const ocid = body["OriginatorConversationID"] as string;
    expect(ocid).toMatch(/^[0-9a-f]{16}$/);
    expect(ocid.length).toBeLessThanOrEqual(19);
    // The caller's object is NEVER mutated (value semantics)
    expect((req as Record<string, unknown>).originatorConversationID).toBeUndefined();
    expect((req as Record<string, unknown>).senderIdentifierType).toBeUndefined();
  });

  it("passes an explicit OriginatorConversationID and identifier types through verbatim", async () => {
    const seen = mockTransport();
    await makeClient().b2bPayment(
      b2bReq({
        originatorConversationID: "a".repeat(19),
        senderIdentifierType: "4",
        receiverIdentifierType: "11",
      }),
    );

    const body = seen[0]?.body ?? {};
    expect(body["OriginatorConversationID"]).toBe("a".repeat(19));
    expect(body["SenderIdentifierType"]).toBe("4");
    expect(body["ReceiverIdentifierType"]).toBe("11");
  });

  it("B2C-style commands are rejected client-side before any fetch", async () => {
    const client = makeClient();
    for (const bad of [
      CommandID.SalaryPayment,
      CommandID.BusinessPayment,
      CommandID.TaxRemittance,
    ]) {
      await expect(
        client.b2bPayment(b2bReq({ commandID: bad })),
        `commandID=${bad.value}`,
      ).rejects.toThrow(
        `mpesa: B2B CommandID ${JSON.stringify(bad.value)} not in {BusinessPayBill, BusinessBuyGoods}`,
      );
    }
    // A fabricated wire value behaves identically
    await expect(
      client.b2bPayment(b2bReq({ commandID: new CommandID("BusinessBuyGood") })),
    ).rejects.toThrow("not in {BusinessPayBill, BusinessBuyGoods}");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shortcode SHAPE gate on PartyA and PartyB runs before any fetch", async () => {
    const client = makeClient();
    for (const bad of ["abc", "12", "12345678901", "x".repeat(300), ""]) {
      await expect(
        client.b2bPayment(b2bReq({ partyA: bad })),
        `partyA=${bad.slice(0, 12)}`,
      ).rejects.toThrow(/^(mpesa: PartyA is required|mpesa: PartyA must be 5-10 ASCII digits)/);
      await expect(
        client.b2bPayment(b2bReq({ partyB: bad })),
        `partyB=${bad.slice(0, 12)}`,
      ).rejects.toThrow(/^(mpesa: PartyB is required|mpesa: PartyB must be 5-10 ASCII digits)/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("missing required fields are rejected before any fetch", async () => {
    const client = makeClient();
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["initiator", { initiator: "" }, "Initiator"],
      ["securityCredential", { securityCredential: "" }, "SecurityCredential"],
      ["accountReference", { accountReference: "" }, "AccountReference"],
      ["remarks", { remarks: "" }, "Remarks"],
      ["queueTimeOutURL", { queueTimeOutURL: "" }, "QueueTimeOutURL"],
      ["resultURL", { resultURL: "" }, "ResultURL"],
    ];
    for (const [name, override, want] of cases) {
      await expect(
        client.b2bPayment(b2bReq(override)),
        name,
      ).rejects.toThrow(want);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-integer amount before any fetch (requirePositiveInt)", async () => {
    const client = makeClient();
    await expect(client.b2bPayment(b2bReq({ amount: 10.5 }))).rejects.toThrow(
      "positive whole number",
    );
    await expect(client.b2bPayment(b2bReq({ amount: 0 }))).rejects.toThrow(
      "positive whole number",
    );
    await expect(client.b2bPayment(b2bReq({ amount: -1 }))).rejects.toThrow(
      "positive whole number",
    );
    await expect(client.b2bPayment(b2bReq({ amount: Number.NaN }))).rejects.toThrow(
      "positive whole number",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects NaN/non-integer amounts on every NEW amount-taking method before any fetch", async () => {
    const client = makeClient();
    const cases: Array<[string, () => Promise<unknown>]> = [
      ["b2bPayment", () => client.b2bPayment(b2bReq({ amount: Number.NaN }))],
      ["taxRemittance", () => client.taxRemittance(taxReq({ amount: Number.NaN }))],
      ["billRegister", () => client.billRegister(billRegisterReq({ amount: Number.NaN }))],
      ["billUpdate", () =>
        client.billUpdate({ shortCode: "600000", billRefNumber: "INV-001", amount: 10.5 }),
      ],
    ];
    for (const [name, call] of cases) {
      await expect(call(), name).rejects.toThrow("positive whole number");
      // ...and a negative amount is refused by the same gate.
    }
    await expect(client.billUpdate({ shortCode: "600000", billRefNumber: "INV-001", amount: -1 }))
      .rejects.toThrow("positive whole number");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps BOTH identifier types at 12 chars when SUPPLIED, defaults an unset one", async () => {
    const client = makeClient();
    // A 13-char value is refused before any fetch (Go requireMaxLenIfSet(12)
    // / Python _printable(..., 12) parity).
    await expect(
      client.b2bPayment(b2bReq({ senderIdentifierType: "4".repeat(13) })),
    ).rejects.toThrow(/SenderIdentifierType exceeds 12 characters/);
    await expect(
      client.b2bPayment(b2bReq({ receiverIdentifierType: "4".repeat(13) })),
    ).rejects.toThrow(/ReceiverIdentifierType exceeds 12 characters/);
    expect(fetchMock).not.toHaveBeenCalled();

    // An UNSET value is defaulted, never an error: the default itself is sent.
    const seen = mockTransport();
    const req = b2bReq();
    delete (req as Record<string, unknown>).senderIdentifierType;
    delete (req as Record<string, unknown>).receiverIdentifierType;
    await makeClient().b2bPayment(req);
    expect(seen[0]?.body["SenderIdentifierType"]).toBe("4");
    expect(seen[0]?.body["ReceiverIdentifierType"]).toBe("4");
  });

  it("always spells the wire key ReceiverIdentifierType (never RecieverIdentifierType)", async () => {
    const seen = mockTransport();
    await makeClient().b2bPayment(b2bReq());
    expect(seen[0]?.body).not.toHaveProperty("RecieverIdentifierType");
    expect(seen[0]?.body["ReceiverIdentifierType"]).toBe("4");
  });

  it("rejects a 20-char OriginatorConversationID (gateway 500.002.1001 parity)", async () => {
    const client = makeClient();
    await expect(
      client.b2bPayment(b2bReq({ originatorConversationID: "a".repeat(20) })),
    ).rejects.toThrow(/OriginatorConversationID must be 1-19 characters/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a private/localhost QueueTimeOutURL before any fetch (SSRF parity)", async () => {
    const client = makeClient();
    for (const host of ["http://127.0.0.1:8080/x", "http://localhost/cb"]) {
      await expect(client.b2bPayment(b2bReq({ queueTimeOutURL: host }))).rejects.toThrow(
        /must not point to/,
      );
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tax Remittance
// ---------------------------------------------------------------------------

describe("Tax Remittance", () => {
  it("POSTs /mpesa/b2b/v1/remittax with Bearer and the exact wire body", async () => {
    const seen = mockTransport();

    const ack = await makeClient().taxRemittance(
      taxReq({ originatorConversationID: "tax-ocid-0001" }),
    );

    expect(ack.ConversationID).toBe("AG_1");

    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call?.path).toBe("/mpesa/b2b/v1/remittax");
    expect(call?.auth).toBe("Bearer tok-abc123");
    expect(call?.body).toEqual({
      OriginatorConversationID: "tax-ocid-0001",
      Initiator: "testapi",
      SecurityCredential: "cred-b2b",
      CommandID: "TaxRemittance",
      SenderIdentifierType: "4",
      ReceiverIdentifierType: "4",
      Amount: 1000,
      PartyA: "600000",
      PartyB: "572700",
      AccountReference: "TAX-2024-Q3",
      Remarks: "VAT Q3 2024",
      TaxPeriod: "2024Q3",
      TaxObligation: "VAT",
      TaxPayerPIN: "A001234567X",
      QueueTimeOutURL: "https://mydomain.com/timeout",
      ResultURL: "https://mydomain.com/result",
    });
  });

  it("pins CommandID to TaxRemittance — anything else is rejected before any fetch", async () => {
    const client = makeClient();
    for (const bad of [
      CommandID.BusinessPayBill,
      CommandID.BusinessBuyGoods,
      CommandID.BusinessPayment,
      new CommandID("Tax"),
    ]) {
      await expect(
        client.taxRemittance(taxReq({ commandID: bad })),
        `commandID=${bad.value}`,
      ).rejects.toThrow("mpesa: TaxRemittance CommandID must be TaxRemittance");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("injects defaults on an internal copy (caller's object untouched)", async () => {
    const seen = mockTransport();
    const req = taxReq();
    delete (req as Record<string, unknown>).originatorConversationID;

    await makeClient().taxRemittance(req);

    const body = seen[0]?.body ?? {};
    expect(body["SenderIdentifierType"]).toBe("4");
    expect(body["ReceiverIdentifierType"]).toBe("4");
    expect(body["OriginatorConversationID"]).toMatch(/^[0-9a-f]{16}$/);
    expect((req as Record<string, unknown>).originatorConversationID).toBeUndefined();
  });

  it("caps BOTH identifier types at 12 chars when SUPPLIED, defaults an unset one", async () => {
    const client = makeClient();
    await expect(
      client.taxRemittance(taxReq({ senderIdentifierType: "4".repeat(13) })),
    ).rejects.toThrow(/SenderIdentifierType exceeds 12 characters/);
    await expect(
      client.taxRemittance(taxReq({ receiverIdentifierType: "4".repeat(13) })),
    ).rejects.toThrow(/ReceiverIdentifierType exceeds 12 characters/);
    expect(fetchMock).not.toHaveBeenCalled();

    const seen = mockTransport();
    const req = taxReq();
    delete (req as Record<string, unknown>).senderIdentifierType;
    delete (req as Record<string, unknown>).receiverIdentifierType;
    await makeClient().taxRemittance(req);
    expect(seen[0]?.body["SenderIdentifierType"]).toBe("4");
    expect(seen[0]?.body["ReceiverIdentifierType"]).toBe("4");
  });

  it("always spells the wire key ReceiverIdentifierType (never RecieverIdentifierType)", async () => {
    const seen = mockTransport();
    await makeClient().taxRemittance(taxReq());
    expect(seen[0]?.body).not.toHaveProperty("RecieverIdentifierType");
    expect(seen[0]?.body["ReceiverIdentifierType"]).toBe("4");
  });

  it("missing tax-specific fields are rejected before any fetch", async () => {
    const client = makeClient();
    await expect(client.taxRemittance(taxReq({ taxPeriod: "" }))).rejects.toThrow("TaxPeriod");
    await expect(client.taxRemittance(taxReq({ taxObligation: "" }))).rejects.toThrow(
      "TaxObligation",
    );
    await expect(client.taxRemittance(taxReq({ taxPayerPIN: "" }))).rejects.toThrow(
      "TaxPayerPIN",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("TaxObligation is free text, NOT a closed enum (VAT/PAYE/Excise/… all pass)", async () => {
    const seen = mockTransport();
    const client = makeClient();
    for (const obligation of ["VAT", "PAYE", "Excise", "Turnover Tax"]) {
      await client.taxRemittance(taxReq({ taxObligation: obligation }));
    }
    expect(seen.map((s) => s.body["TaxObligation"])).toEqual([
      "VAT", "PAYE", "Excise", "Turnover Tax",
    ]);
  });

  it("shortcode SHAPE gate on both parties runs before any fetch", async () => {
    const client = makeClient();
    await expect(client.taxRemittance(taxReq({ partyA: "1234" }))).rejects.toThrow(
      /PartyA must be 5-10 ASCII digits/,
    );
    await expect(client.taxRemittance(taxReq({ partyB: "123456789012" }))).rejects.toThrow(
      /PartyB must be 5-10 ASCII digits/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-integer / NaN amount before any fetch", async () => {
    const client = makeClient();
    for (const bad of [10.5, 0, -1, Number.NaN]) {
      await expect(
        client.taxRemittance(taxReq({ amount: bad })),
        `amount=${String(bad)}`,
      ).rejects.toThrow("positive whole number");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logSafeRequest masks TaxPayerPIN — JSON.stringify carries no PIN", async () => {
    const req = taxReq();
    const safe = logSafeRequest(req);

    expect(safe.taxPayerPIN).toBe("[REDACTED]");
    expect(safe.securityCredential).toBe("[REDACTED]");
    // The tax period label is NOT a secret and stays visible.
    expect(safe.taxPeriod).toBe("2024Q3");
    // The CommandID enum rides along (it renders as its wire key).
    expect(String(safe.commandID)).toBe("TaxRemittance");

    const json = JSON.stringify(safe);
    expect(json).not.toContain("A001234567X");
    expect(json).not.toContain("cred-b2b");
    expect(json).toContain("[REDACTED]");
    // The caller's object is never mutated by the redaction copy.
    expect(req.taxPayerPIN).toBe("A001234567X");
  });

  it("logSafeRequest drops the callback-token query from both URL fields", async () => {
    const safe = logSafeRequest(
      taxReq({
        queueTimeOutURL: "https://mydomain.com/t?token=0123456789abcdef",
        resultURL: "https://mydomain.com/r?token=deadbeef",
      }),
    );
    expect(safe.queueTimeOutURL).toBe("https://mydomain.com/t");
    expect(safe.resultURL).toBe("https://mydomain.com/r");
    expect(JSON.stringify(safe)).not.toContain("token");
  });
});

// ---------------------------------------------------------------------------
// Bill Manager — register
// ---------------------------------------------------------------------------

describe("Bill Manager — register", () => {
  it("POSTs /mpesa/billmanager/v1/register with Bearer and the exact wire body", async () => {
    const seen = mockTransport(() => BILL_ACK_WITH_REF);

    const ack = await makeClient().billRegister(billRegisterReq());

    expect(ack.ResponseCode).toBe("0");
    expect(ack.ConversationID).toBe("AG_2");
    expect(ack.BillRefNumber).toBe("INV-001");

    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call?.path).toBe("/mpesa/billmanager/v1/register");
    expect(call?.auth).toBe("Bearer tok-abc123");
    expect(call?.body).toEqual({
      ShortCode: "600000",
      BillRefNumber: "INV-001",
      BillName: "Invoice 001",
      Amount: 1000,
      ExpiryDate: "2024-12-31",
      CallBackURL: "https://mydomain.com/bill",
    });
  });

  it("normalizes a supplied PayerNumber and includes the optional PII fields", async () => {
    const seen = mockTransport(() => BILL_ACK_WITH_REF);

    await makeClient().billRegister(
      billRegisterReq({ payerNumber: "0712345678", payerName: "Jane Doe" }),
    );

    const body = seen[0]?.body ?? {};
    expect(body["PayerNumber"]).toBe("254712345678");
    expect(body["PayerName"]).toBe("Jane Doe");
  });

  it("omits PayerNumber/PayerName from the payload when unset (or explicitly empty)", async () => {
    const seen = mockTransport(() => BILL_ACK_WITH_REF);

    await makeClient().billRegister(billRegisterReq());

    expect(seen[0]?.body["PayerNumber"]).toBeUndefined();
    expect(seen[0]?.body["PayerName"]).toBeUndefined();
  });

  it("rejects a bad shortcode / missing field / bad payer phone before any fetch", async () => {
    const client = makeClient();
    await expect(client.billRegister(billRegisterReq({ shortCode: "1234" }))).rejects.toThrow(
      /ShortCode must be 5-10 ASCII digits/,
    );
    await expect(client.billRegister(billRegisterReq({ billRefNumber: "" }))).rejects.toThrow(
      "BillRefNumber",
    );
    await expect(client.billRegister(billRegisterReq({ billName: "" }))).rejects.toThrow(
      "BillName",
    );
    await expect(client.billRegister(billRegisterReq({ expiryDate: "" }))).rejects.toThrow(
      "ExpiryDate",
    );
    await expect(
      client.billRegister(billRegisterReq({ payerNumber: "07123" })),
    ).rejects.toThrow(/MSISDN/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("defaults ShortCode from the configured shortcode when omitted, passes an explicit one through", async () => {
    const seen = mockTransport(() => BILL_ACK_WITH_REF);

    // Omitted → the config shortcode (SHORTCODE) travels on the wire.
    const req = billRegisterReq();
    delete (req as Record<string, unknown>).shortCode;
    await makeClient().billRegister(req);
    expect(seen[0]?.body["ShortCode"]).toBe(SHORTCODE);
    // Value semantics: the caller's object is untouched.
    expect((req as Record<string, unknown>).shortCode).toBeUndefined();

    // Explicit → passthrough.
    const seen2 = mockTransport(() => BILL_ACK_WITH_REF);
    await makeClient().billRegister(billRegisterReq({ shortCode: "600000" }));
    expect(seen2[0]?.body["ShortCode"]).toBe("600000");
  });

  it("always spells the wire key ReceiverIdentifierType (never RecieverIdentifierType)", async () => {
    const seen = mockTransport(() => BILL_ACK_WITH_REF);
    await makeClient().billRegister(billRegisterReq());
    expect(seen[0]?.body).not.toHaveProperty("RecieverIdentifierType");
    expect(seen[0]?.body["BillRefNumber"]).toBe("INV-001");
  });

  it("rejects a non-integer amount before any fetch", async () => {
    const client = makeClient();
    await expect(client.billRegister(billRegisterReq({ amount: 10.5 }))).rejects.toThrow(
      "positive whole number",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-integer / NaN amount before any fetch", async () => {
    const client = makeClient();
    for (const bad of [10.5, 0, -1, Number.NaN]) {
      await expect(
        client.billRegister(billRegisterReq({ amount: bad })),
        `amount=${String(bad)}`,
      ).rejects.toThrow("positive whole number");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("drops a whitespace-only payerNumber/payerName instead of sending spaces", async () => {
    const seen = mockTransport(() => BILL_ACK_WITH_REF);

    const req = billRegisterReq({ payerNumber: "   ", payerName: "   " });
    await makeClient().billRegister(req);

    const body = seen[0]?.body ?? {};
    expect(body["PayerNumber"]).toBeUndefined();
    expect(body["PayerName"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Bill Manager — query / update / delete
// ---------------------------------------------------------------------------

describe("Bill Manager — query / update / delete", () => {
  it("query POSTs /mpesa/billmanager/v1/query with exactly ShortCode + BillRefNumber", async () => {
    const seen = mockTransport(() => BILL_ACK_WITHOUT_REF);

    const ack = await makeClient().billQuery({ shortCode: "600000", billRefNumber: "INV-001" });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe("/mpesa/billmanager/v1/query");
    expect(seen[0]?.auth).toBe("Bearer tok-abc123");
    expect(seen[0]?.body).toEqual({ ShortCode: "600000", BillRefNumber: "INV-001" });
    // BillRefNumber is OPTIONAL on the wire — its absence is tolerated.
    expect(ack.BillRefNumber).toBeUndefined();
    expect(ack.ConversationID).toBe("AG_2");
  });

  it("delete POSTs /mpesa/billmanager/v1/delete with exactly ShortCode + BillRefNumber", async () => {
    const seen = mockTransport(() => BILL_ACK_WITHOUT_REF);

    await makeClient().billDelete({ shortCode: "600000", billRefNumber: "INV-001" });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe("/mpesa/billmanager/v1/delete");
    expect(seen[0]?.body).toEqual({ ShortCode: "600000", BillRefNumber: "INV-001" });
  });

  it("update POSTs /mpesa/billmanager/v1/update and OMITS unset optional fields", async () => {
    const seen = mockTransport(() => BILL_ACK_WITH_REF);

    await makeClient().billUpdate({
      shortCode: "600000",
      billRefNumber: "INV-001",
      amount: 1500,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe("/mpesa/billmanager/v1/update");
    expect(seen[0]?.body).toEqual({
      ShortCode: "600000",
      BillRefNumber: "INV-001",
      Amount: 1500,
    });
    // A partial update must never send zero/empty siblings.
    expect(seen[0]?.body["ExpiryDate"]).toBeUndefined();
    expect(seen[0]?.body["CallBackURL"]).toBeUndefined();
    expect(seen[0]?.body["PayerNumber"]).toBeUndefined();
    expect(seen[0]?.body["PayerName"]).toBeUndefined();
  });

  it("update with NO optional fields sends EXACTLY ShortCode + BillRefNumber", async () => {
    const seen = mockTransport(() => BILL_ACK_WITHOUT_REF);

    await makeClient().billUpdate({ shortCode: "600000", billRefNumber: "INV-001" });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.body).toEqual({ ShortCode: "600000", BillRefNumber: "INV-001" });
    for (const key of ["Amount", "ExpiryDate", "CallBackURL", "PayerNumber", "PayerName"]) {
      expect(seen[0]?.body).not.toHaveProperty(key);
    }
  });

  it("update rejects amount: 0 as non-positive BEFORE any dispatch", async () => {
    const client = makeClient();
    // TypeScript has no Go/Python "Amount: 0 means unset" sentinel: an
    // explicit 0 is a mistake, not a partial update. Omitting the key is
    // how a partial update is spelled.
    await expect(
      client.billUpdate({ shortCode: "600000", billRefNumber: "INV-001", amount: 0 }),
    ).rejects.toThrow("positive whole number");
    await expect(
      client.billUpdate({ shortCode: "600000", billRefNumber: "INV-001", amount: Number.NaN }),
    ).rejects.toThrow("positive whole number");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("update drops a whitespace-only payerNumber/payerName instead of sending spaces", async () => {
    const seen = mockTransport(() => BILL_ACK_WITHOUT_REF);

    await makeClient().billUpdate({
      shortCode: "600000",
      billRefNumber: "INV-001",
      payerNumber: "  ",
      payerName: "   ",
    });

    const body = seen[0]?.body ?? {};
    expect(body["PayerNumber"]).toBeUndefined();
    expect(body["PayerName"]).toBeUndefined();
    // The two identifiers still travel.
    expect(body).toEqual({ ShortCode: "600000", BillRefNumber: "INV-001" });
  });

  it("query/update/delete default ShortCode from the configured shortcode when omitted", async () => {
    const seen = mockTransport(() => BILL_ACK_WITH_REF);

    // All three, with NO shortCode on the caller's object.
    const q = { billRefNumber: "INV-001" };
    const u = { billRefNumber: "INV-001", amount: 1500 };
    const d = { billRefNumber: "INV-001" };
    const client = makeClient();
    await client.billQuery(q);
    await client.billUpdate(u);
    await client.billDelete(d);

    expect(seen).toHaveLength(3);
    expect(seen[0]?.body["ShortCode"]).toBe(SHORTCODE);
    expect(seen[1]?.body["ShortCode"]).toBe(SHORTCODE);
    expect(seen[2]?.body["ShortCode"]).toBe(SHORTCODE);
    // Value semantics: the callers' objects never gained the field.
    expect(q).not.toHaveProperty("shortCode");
    expect(u).not.toHaveProperty("shortCode");
    expect(d).not.toHaveProperty("shortCode");

    // An explicit shortcode passes through untouched.
    const seen2 = mockTransport(() => BILL_ACK_WITH_REF);
    await makeClient().billQuery({ shortCode: "600000", billRefNumber: "INV-001" });
    expect(seen2[0]?.body["ShortCode"]).toBe("600000");
  });

  it("update carries every supplied optional field (normalizing PayerNumber)", async () => {
    const seen = mockTransport(() => BILL_ACK_WITH_REF);

    await makeClient().billUpdate({
      shortCode: "600000",
      billRefNumber: "INV-001",
      amount: 2000,
      expiryDate: "2025-06-30",
      callBackURL: "https://mydomain.com/bill2",
      payerNumber: "+254712345678",
      payerName: "Jane Doe",
    });

    expect(seen[0]?.body).toEqual({
      ShortCode: "600000",
      BillRefNumber: "INV-001",
      Amount: 2000,
      ExpiryDate: "2025-06-30",
      CallBackURL: "https://mydomain.com/bill2",
      PayerNumber: "254712345678",
      PayerName: "Jane Doe",
    });
  });

  it("query/delete reject a malformed shortcode or empty BillRefNumber before any fetch", async () => {
    const client = makeClient();
    for (const call of [
      () => client.billQuery({ shortCode: "abc", billRefNumber: "INV-001" }),
      () => client.billDelete({ shortCode: "12345678901", billRefNumber: "INV-001" }),
    ]) {
      await expect(call()).rejects.toThrow(/ShortCode must be 5-10 ASCII digits/);
    }
    await expect(
      client.billQuery({ shortCode: "600000", billRefNumber: "" }),
    ).rejects.toThrow("BillRefNumber");
    await expect(
      client.billDelete({ shortCode: "600000", billRefNumber: "" }),
    ).rejects.toThrow("BillRefNumber");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logSafeRequest masks payerNumber/payerName but NOT billRefNumber", async () => {
    const req = billRegisterReq({ payerNumber: "254712345678", payerName: "Jane Doe" });
    const safe = logSafeRequest(req);

    expect(safe.payerNumber).toBe("[REDACTED]");
    expect(safe.payerName).toBe("[REDACTED]");
    // billRefNumber is the caller's JOIN KEY, not a secret — it stays visible.
    expect(safe.billRefNumber).toBe("INV-001");
    expect(safe.shortCode).toBe("600000");

    const json = JSON.stringify(safe);
    expect(json).not.toContain("254712345678");
    expect(json).not.toContain("Jane Doe");
    expect(json).toContain("INV-001");
    // The caller's object is never mutated.
    expect(req.payerNumber).toBe("254712345678");
  });
});

// ---------------------------------------------------------------------------
// Value semantics across all six methods
// ---------------------------------------------------------------------------

describe("Value semantics — the caller's object is never mutated", () => {
  it("none of the six new methods mutate the caller's request", async () => {
    mockTransport(() => ({
      ...CONVERSATION_ACK,
      ...BILL_ACK_WITH_REF,
    }));

    const b2b = b2bReq();
    const tax = taxReq();
    const reg = billRegisterReq();
    const query = { shortCode: "600000", billRefNumber: "INV-001" };
    const update = { shortCode: "600000", billRefNumber: "INV-001", amount: 1500 };
    const del = { shortCode: "600000", billRefNumber: "INV-001" };

    const frozenSnapshots = [b2b, tax, reg, query, update, del].map((r) => ({ ...r }));

    const client = makeClient();
    await client.b2bPayment(b2b);
    await client.taxRemittance(tax);
    await client.billRegister(reg);
    await client.billQuery(query);
    await client.billUpdate(update);
    await client.billDelete(del);

    // No originatorConversationID / identifier types leaked back onto the
    // caller's B2B/Tax objects.
    expect(b2b).toEqual(frozenSnapshots[0]);
    expect(tax).toEqual(frozenSnapshots[1]);
    expect("originatorConversationID" in b2b).toBe(false);
    expect("senderIdentifierType" in tax).toBe(false);
    expect(reg).toEqual(frozenSnapshots[2]);
    expect(query).toEqual(frozenSnapshots[3]);
    expect(update).toEqual(frozenSnapshots[4]);
    expect(del).toEqual(frozenSnapshots[5]);
  });
});

// ---------------------------------------------------------------------------
// Per-transaction ceilings (b2b / tax / bill buckets)
// ---------------------------------------------------------------------------

describe("Per-transaction ceilings — b2b / tax / bill", () => {
  it("each new bucket enforces its own default 250000 ceiling, fail-fast", async () => {
    const seen = mockTransport();
    const client = makeClient();

    await client.b2bPayment(b2bReq({ amount: 250_000 }));
    await client.taxRemittance(taxReq({ amount: 250_000 }));
    await client.billRegister(billRegisterReq({ amount: 250_000 }));
    expect(seen).toHaveLength(3);

    for (const call of [
      () => client.b2bPayment(b2bReq({ amount: 250_001 })),
      () => client.taxRemittance(taxReq({ amount: 250_001 })),
      () => client.billRegister(billRegisterReq({ amount: 250_001 })),
    ]) {
      await expect(call()).rejects.toThrow(MpesaError);
    }
    // Fail-fast: the three rejections never dispatched.
    expect(seen).toHaveLength(3);
  });

  it("the error names the service, the ceiling, and the override path", async () => {
    const client = makeClient();
    let caught: unknown;
    try {
      await client.b2bPayment(b2bReq({ amount: 300_000 }));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MpesaError);
    const err = caught as MpesaError;
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain("B2B amount 300000");
    expect(err.message).toContain("per-transaction limit of 250000 KES");
    expect(err.message).toContain("limits.b2b.maxPerTransaction");
    expect(err.message).toContain("0 = unlimited");
  });

  it("an override RAISES a ceiling for each new bucket", async () => {
    const seen = mockTransport();
    const client = makeClient({
      limits: {
        b2b: { maxPerTransaction: 500_000 },
        tax: { maxPerTransaction: 500_000 },
        bill: { maxPerTransaction: 500_000 },
      },
    });

    await client.b2bPayment(b2bReq({ amount: 500_000 }));
    await client.taxRemittance(taxReq({ amount: 500_000 }));
    await client.billRegister(billRegisterReq({ amount: 500_000 }));
    expect(seen).toHaveLength(3);

    await expect(client.b2bPayment(b2bReq({ amount: 500_001 }))).rejects.toThrow(
      /per-transaction limit of 500000/,
    );
  });

  it("an override LOWERS a ceiling for the tax bucket", async () => {
    const seen = mockTransport();
    const client = makeClient({ limits: { tax: { maxPerTransaction: 100 } } });

    await client.taxRemittance(taxReq({ amount: 100 }));
    expect(seen).toHaveLength(1);
    await expect(client.taxRemittance(taxReq({ amount: 101 }))).rejects.toThrow(
      /Tax amount 101 exceeds the configured per-transaction limit of 100/,
    );
    expect(seen).toHaveLength(1);
  });

  it("0 (UNLIMITED) disables a new bucket's per-transaction ceiling", async () => {
    const seen = mockTransport();
    const client = makeClient({ limits: { b2b: { maxPerTransaction: 0 } } });

    await client.b2bPayment(b2bReq({ amount: 5_000_000 }));
    expect(seen).toHaveLength(1);
  });

  it("a `default` override does NOT reach b2b/tax/bill (own buckets)", async () => {
    const seen = mockTransport();
    const client = makeClient({ limits: { default: { maxPerTransaction: 1_000 } } });

    await client.b2bPayment(b2bReq({ amount: 2_000 }));
    await client.taxRemittance(taxReq({ amount: 2_000 }));
    await client.billRegister(billRegisterReq({ amount: 2_000 }));
    expect(seen).toHaveLength(3);
  });

  it("query and delete carry no amount, so no limits gate applies", async () => {
    const seen = mockTransport(() => BILL_ACK_WITHOUT_REF);
    // Even with absurd ceilings configured, query/delete never touch them.
    const client = makeClient({ limits: { bill: { maxPerTransaction: 1 } } });

    await client.billQuery({ shortCode: "600000", billRefNumber: "INV-001" });
    await client.billDelete({ shortCode: "600000", billRefNumber: "INV-001" });
    await client.billUpdate({ shortCode: "600000", billRefNumber: "INV-001" });
    expect(seen).toHaveLength(3);
  });

  it("billUpdate gates only when an amount is actually supplied", async () => {
    const seen = mockTransport(() => BILL_ACK_WITH_REF);
    const client = makeClient({ limits: { bill: { maxPerTransaction: 1_000 } } });

    // No amount → nothing to spend → no gate, and no NaN accrual.
    await client.billUpdate({ shortCode: "600000", billRefNumber: "INV-001" });
    // Amount under the ceiling → fine.
    await client.billUpdate({ shortCode: "600000", billRefNumber: "INV-001", amount: 1_000 });
    expect(seen).toHaveLength(2);
    // Amount OVER the ceiling → rejected before any dispatch.
    await expect(
      client.billUpdate({ shortCode: "600000", billRefNumber: "INV-001", amount: 1_001 }),
    ).rejects.toThrow(/per-transaction limit of 1000/);
    expect(seen).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Daily accounting — opt-in, transport-only rollback (b2b/tax/bill buckets)
// ---------------------------------------------------------------------------

describe("Daily accounting for the new buckets", () => {
  it("b2b: is OFF by default — no daily gate, no accumulator", async () => {
    const seen = mockTransport();
    const client = makeClient({ limits: { b2b: { maxPerDay: 1 } } });

    await client.b2bPayment(b2bReq({ amount: 100_000 }));
    await client.b2bPayment(b2bReq({ amount: 100_000 }));
    expect(seen).toHaveLength(2);
  });

  it("b2b/tax/bill: enforces maxPerDay once enabled, without dispatching", async () => {
    const seen = mockTransport();
    const client = makeClient({
      limits: {
        b2b: { maxPerTransaction: 0, maxPerDay: 500_000 },
        tax: { maxPerTransaction: 0, maxPerDay: 500_000 },
        bill: { maxPerTransaction: 0, maxPerDay: 500_000 },
      },
      trackDaily: true,
    });

    await client.b2bPayment(b2bReq({ amount: 300_000 })); // b2b: 300_000 used
    await client.taxRemittance(taxReq({ amount: 300_000 })); // tax: 300_000 used
    await client.billRegister(billRegisterReq({ amount: 300_000 })); // bill: 300_000 used
    expect(seen).toHaveLength(3);

    for (const call of [
      () => client.b2bPayment(b2bReq({ amount: 300_000 })),
      () => client.taxRemittance(taxReq({ amount: 300_000 })),
      () => client.billRegister(billRegisterReq({ amount: 300_000 })),
    ]) {
      await expect(call()).rejects.toThrow(/daily limit reached/);
    }
    // Fail-fast: no extra dispatch for the three rejections.
    expect(seen).toHaveLength(3);
  });

  it("refunds the accrual on TRANSPORT failure, keeps it on gateway errors (b2b)", async () => {
    // (a) Transport failure (fetch rejects) — the reservation is refunded.
    mockTransportFailure();
    const client = makeClient({
      limits: { b2b: { maxPerTransaction: 0, maxPerDay: 500_000 } },
      trackDaily: true,
    });
    await expect(client.b2bPayment(b2bReq({ amount: 300_000 }))).rejects.toThrow(
      /fetch failed/,
    );
    const seen = mockTransport();
    await client.b2bPayment(b2bReq({ amount: 300_000 }));
    expect(seen).toHaveLength(1); // fits again — 300_000 + 300_000 ≤ 500_000

    // (b) Gateway rejection (400 + MpesaError) — the reservation STICKS.
    const gated = makeClient({
      limits: { tax: { maxPerTransaction: 0, maxPerDay: 400_000 } },
      trackDaily: true,
    });
    mockGatewayError();
    await expect(gated.taxRemittance(taxReq({ amount: 300_000 }))).rejects.toThrow(MpesaError);
    const secondSeen = mockTransport();
    await expect(gated.taxRemittance(taxReq({ amount: 150_001 }))).rejects.toThrow(
      /daily limit reached/,
    );
    await gated.taxRemittance(taxReq({ amount: 100_000 }));
    expect(secondSeen).toHaveLength(1);
  });

  it("the new buckets are independent of each other and of the legacy ones", async () => {
    const seen = mockTransport();
    const client = makeClient({
      limits: {
        b2b: { maxPerTransaction: 0, maxPerDay: 500_000 },
        bill: { maxPerTransaction: 0, maxPerDay: 500_000 },
      },
      trackDaily: true,
    });

    await client.b2bPayment(b2bReq({ amount: 500_000 })); // fill b2b
    await expect(client.b2bPayment(b2bReq({ amount: 10 }))).rejects.toThrow(
      /B2B daily limit reached/,
    );
    // The bill bucket is untouched by the b2b spend.
    await client.billRegister(billRegisterReq({ amount: 500_000 }));
    expect(seen).toHaveLength(2);
  });
});
