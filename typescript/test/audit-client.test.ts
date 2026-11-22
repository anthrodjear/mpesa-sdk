/**
 * Phase-3 audit pins for the TypeScript client (client.ts / types.ts):
 *  - QR `Size` uses a strict canonical numeric-string gate;
 *  - STK free-text rejects control characters Daraja echoes into logs;
 *  - construction fails closed on a TLS-downgrade environment;
 *  - the opaque QR payload is never truncated at the generic 4096 cap;
 *  - `close()` stops the client without disturbing the shared token cache.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MpesaClient } from "../src/client.js";
import { Config, Environment } from "../src/config.js";
import { QRTrxCode, TransactionType } from "../src/enums.js";

const CONSUMER_KEY = "audit-key";
const CONSUMER_SECRET = "audit-secret";

const CONFIG = new Config({
  consumerKey: CONSUMER_KEY,
  consumerSecret: CONSUMER_SECRET,
  shortcode: "174379",
  passkey: "audit-passkey",
  environment: Environment.SANDBOX,
});

const FIXED_CLOCK_MS = new Date("2021-06-28T09:24:08Z").getTime();
const VALID_TOKEN_RESPONSE = {
  access_token: "tok-audit",
  expires_in: "3599",
  token_type: "Bearer",
};

/** Mutable QR wire envelope so a test can inject an oversized payload. */
let qrWire: Record<string, unknown>;
/** Signals the in-flight test waits on before calling close(). */
let capturedSignal: AbortSignal | undefined;
/** When true, the QR business call hangs until its abort signal fires. */
let hangBusiness = false;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function baseQRRequest() {
  return {
    merchantName: "TEST SUPERMARKET",
    refNo: "Invoice Test",
    amount: 1,
    trxCode: QRTrxCode.BuyGoods,
    cpi: "174379",
    size: "300",
  };
}

function baseSTKRequest() {
  return {
    transactionType: TransactionType.BillPayGoods,
    amount: 1,
    partyA: "254722000000",
    phoneNumber: "254722111111",
    callBackURL: "https://mydomain.com/path",
    accountReference: "Order123",
    transactionDesc: "Payment",
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  qrWire = {
    ResponseCode: "AG_20191219_000043fdf6",
    RequestID: "16738-27456357-1",
    ResponseDescription: "QR Code Successfully Generated",
    QRCode: "qrpayload",
  };
  capturedSignal = undefined;
  hangBusiness = false;
  fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/oauth/v1/generate")) return jsonResponse(VALID_TOKEN_RESPONSE);
    if (url.includes("/qrcode/v1/generate")) {
      if (hangBusiness) {
        // In-flight test: hang the business call until its signal aborts.
        capturedSignal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          capturedSignal?.addEventListener("abort", () =>
            reject(new Error("aborted by close")),
          );
        });
      }
      return jsonResponse(qrWire);
    }
    if (url.includes("/stkpush/v1/processrequest")) {
      return jsonResponse({ ResponseCode: "0", ResponseDescription: "ok" });
    }
    return new Response("not found", { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Client with injected clock/timeout — private token manager, no cross-test state. */
function newClient(): MpesaClient {
  return new MpesaClient({ config: CONFIG, timeoutMs: 200, now: () => FIXED_CLOCK_MS });
}

function businessCallBody(): Record<string, unknown> {
  const call = fetchMock.mock.calls.find((c: unknown[]) =>
    String(c[0]).includes("/qrcode/v1/generate"),
  );
  expect(call).toBeDefined();
  const init = (call as unknown[])[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// QR Size strict canonical gate
// ---------------------------------------------------------------------------

describe("generateQRCode Size validation", () => {
  it("rejects '300px' and '3.5' locally (parseInt would have accepted both)", async () => {
    const client = newClient();
    await expect(
      client.generateQRCode({ ...baseQRRequest(), size: "300px" }),
    ).rejects.toThrow(/Size/);
    await expect(
      client.generateQRCode({ ...baseQRRequest(), size: "3.5" }),
    ).rejects.toThrow(/Size/);
    // Validation happens before any token fetch or payload dispatch.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts '300' and puts the validated value in the wire payload", async () => {
    const client = newClient();
    const resp = await client.generateQRCode({ ...baseQRRequest(), size: "300" });
    expect(resp.QRCode).toBe("qrpayload");
    expect(businessCallBody()["Size"]).toBe("300");
  });
});

// ---------------------------------------------------------------------------
// STK free-text printable gate
// ---------------------------------------------------------------------------

describe("stkPush free-text printable gate", () => {
  it("rejects newlines/NUL in AccountReference and TransactionDesc", async () => {
    const client = newClient();
    await expect(
      client.stkPush({ ...baseSTKRequest(), accountReference: "ok\nforged-log-line" }),
    ).rejects.toThrow(/AccountReference.*non-printable/);
    await expect(
      client.stkPush({ ...baseSTKRequest(), transactionDesc: "ok\u0000bad" }),
    ).rejects.toThrow(/TransactionDesc.*non-printable/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still accepts ordinary printable values", async () => {
    const client = newClient();
    await expect(client.stkPush(baseSTKRequest())).resolves.toMatchObject({
      ResponseCode: "0",
    });
  });
});

// ---------------------------------------------------------------------------
// TLS-downgrade fail-closed construction
// ---------------------------------------------------------------------------

describe("TLS-downgrade guard", () => {
  it("throws on NODE_TLS_REJECT_UNAUTHORIZED=0 and recovers with '1'", () => {
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    expect(() => newClient()).toThrow(/NODE_TLS_REJECT_UNAUTHORIZED/);
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "1");
    expect(() => newClient()).not.toThrow();
  });

  it("also rejects the empty string and 'false' spellings", () => {
    for (const value of ["", "false"]) {
      vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", value);
      expect(() => newClient()).toThrow(/certificate verification/);
    }
  });

  it("guards injected-fetch clients too", () => {
    vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "0");
    expect(() => new MpesaClient({ config: CONFIG, fetch: fetchMock })).toThrow(
      /NODE_TLS_REJECT_UNAUTHORIZED/,
    );
  });
});

// ---------------------------------------------------------------------------
// Opaque QR payload preservation
// ---------------------------------------------------------------------------

describe("QRCodeResponse decoding", () => {
  it("preserves a QR payload longer than 4096 characters verbatim", async () => {
    const bigPayload = "data:image/png;base64," + "A".repeat(6000);
    qrWire = { ...qrWire, QRCode: bigPayload };
    const resp = await newClient().generateQRCode(baseQRRequest());
    expect(resp.QRCode).toBe(bigPayload);
    expect(resp.QRCode.length).toBeGreaterThan(4096);
  });

  it("keeps the generic 4096-char cap on the diagnostic fields", async () => {
    qrWire = { ...qrWire, ResponseCode: "X".repeat(5000) };
    const resp = await newClient().generateQRCode(baseQRRequest());
    expect(resp.ResponseCode).toHaveLength(4096);
    expect(resp.QRCode).toBe("qrpayload");
  });
});

// ---------------------------------------------------------------------------
// close() lifecycle
// ---------------------------------------------------------------------------

describe("MpesaClient.close()", () => {
  it("is idempotent and makes subsequent endpoint calls fail fast", async () => {
    const client = newClient();
    client.close();
    client.close();
    await expect(client.generateQRCode(baseQRRequest())).rejects.toThrow(/closed/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts in-flight requests owned by the client", async () => {
    hangBusiness = true;
    const client = newClient();
    const pending = client.generateQRCode(baseQRRequest());
    await vi.waitFor(() => expect(capturedSignal).toBeDefined());
    client.close();
    await expect(pending).rejects.toThrow(/aborted|closed/);
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("does not disturb a sibling client sharing the token manager", async () => {
    // Default construction (no injected fetch/now/timeout) shares one
    // TokenManager per credential set; closing one client must not break it.
    const first = new MpesaClient({ config: CONFIG });
    const sibling = new MpesaClient({ config: CONFIG });
    first.close();
    await expect(sibling.generateQRCode(baseQRRequest())).resolves.toMatchObject({
      QRCode: "qrpayload",
    });
  });
});
