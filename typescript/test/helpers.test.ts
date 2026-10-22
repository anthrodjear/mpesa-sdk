/**
 * Tests for src/helpers.ts — password generation, phone normalization,
 * RSA security credential, and originator ID.
 *
 * Mirrors go/helpers.go and python/mpesa/helpers.py with exact golden
 * vectors and identical edge-case coverage.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generatePassword,
  normalizePhone,
  securityCredential,
  newOriginatorID,
} from "../src/helpers.js";

// ---------------------------------------------------------------------------
// Fixture: sandbox certificate (PEM)
// ---------------------------------------------------------------------------

const SANDBOX_CERT_PATH = join(
  import.meta.dirname,
  "..",
  "..",
  "assets",
  "certs",
  "SandboxCertificate.cer",
);
const SANDBOX_CERT_PEM = readFileSync(SANDBOX_CERT_PATH);

// ---------------------------------------------------------------------------
// generatePassword
// ---------------------------------------------------------------------------

describe("generatePassword", () => {
  const SHORTCODE = "174379";
  const PASSKEY =
    "bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919";
  const EXPECTED_TIMESTAMP = "20210628122408";
  const EXPECTED_PASSWORD =
    "MTc0Mzc5YmZiMjc5ZjlhYTliZGJjZjE1OGU5N2RkNzFhNDY3Y2QyZTBjODkzMDU5" +
    "YjEwZjc4ZTZiNzJhZGExZWQyYzkxOTIwMjEwNjI4MTIyNDA4";

  it("golden vector: exact timestamp + password match", () => {
    const { password, timestamp } = generatePassword(
      SHORTCODE,
      PASSKEY,
      new Date("2021-06-28T09:24:08Z"),
    );
    expect(timestamp).toBe(EXPECTED_TIMESTAMP);
    expect(password).toBe(EXPECTED_PASSWORD);
  });

  it("EAT offset: UTC+3 confirmed", () => {
    // 2021-06-28T09:24:08Z → EAT should be 12:24:08 → "20210628122408"
    const { timestamp } = generatePassword(
      SHORTCODE,
      PASSKEY,
      new Date("2021-06-28T09:24:08Z"),
    );
    // Hour in timestamp should be 12 (09 UTC + 3)
    expect(timestamp.slice(8, 10)).toBe("12");
  });

  it("EAT midnight rollover: 21:00 UTC → 00:00 EAT next day", () => {
    const { timestamp } = generatePassword(
      SHORTCODE,
      PASSKEY,
      new Date("2021-06-28T21:00:00Z"),
    );
    // 21:00 UTC + 3h = 00:00 EAT next day
    expect(timestamp).toBe("20210629000000");
  });

  it("two-clock bug: timestamp in result matches password", () => {
    const { password, timestamp } = generatePassword(
      SHORTCODE,
      PASSKEY,
      new Date("2021-06-28T09:24:08Z"),
    );
    // The password must be base64(shortcode + passkey + timestamp)
    // where timestamp is EXACTLY the same string returned
    const expected = Buffer.from(
      SHORTCODE + PASSKEY + timestamp,
      "utf-8",
    ).toString("base64");
    expect(password).toBe(expected);
  });

  it("defaults to current time when timestamp omitted", () => {
    const before = Date.now();
    const { password, timestamp } = generatePassword(SHORTCODE, PASSKEY);
    const after = Date.now();

    // Timestamp should be a 14-digit EAT string
    expect(timestamp).toMatch(/^\d{14}$/);

    // Verify the password is derived from the same timestamp
    const expected = Buffer.from(
      SHORTCODE + PASSKEY + timestamp,
      "utf-8",
    ).toString("base64");
    expect(password).toBe(expected);

    // Timestamp should be within the test window (EAT = UTC+3)
    const tsMs =
      Date.UTC(
        Number(timestamp.slice(0, 4)),
        Number(timestamp.slice(4, 6)) - 1,
        Number(timestamp.slice(6, 8)),
        Number(timestamp.slice(8, 10)),
        Number(timestamp.slice(10, 12)),
        Number(timestamp.slice(12, 14)),
      ) -
      3 * 3600_000; // back to UTC
    expect(tsMs).toBeGreaterThanOrEqual(before - 1000);
    expect(tsMs).toBeLessThanOrEqual(after + 1000);
  });

  it("rejects NaN date", () => {
    expect(() =>
      generatePassword(SHORTCODE, PASSKEY, new Date("not-a-date")),
    ).toThrow("mpesa: invalid Date");
  });

  it("password is valid base64", () => {
    const { password } = generatePassword(
      SHORTCODE,
      PASSKEY,
      new Date("2021-06-28T09:24:08Z"),
    );
    // Should not throw when decoding
    const decoded = Buffer.from(password, "base64").toString("utf-8");
    expect(decoded).toContain(SHORTCODE);
    expect(decoded).toContain(PASSKEY);
    expect(decoded).toContain(EXPECTED_TIMESTAMP);
  });
});

// ---------------------------------------------------------------------------
// normalizePhone
// ---------------------------------------------------------------------------

describe("normalizePhone", () => {
  it("0712345678 → 254712345678", () => {
    expect(normalizePhone("0712345678")).toBe("254712345678");
  });

  it("+254712345678 → 254712345678", () => {
    expect(normalizePhone("+254712345678")).toBe("254712345678");
  });

  it("254712345678 → 254712345678 (passthrough)", () => {
    expect(normalizePhone("254712345678")).toBe("254712345678");
  });

  it("0712345678 with mid-string spaces", () => {
    expect(normalizePhone("0712 345 678")).toBe("254712345678");
  });

  it("+254 with dashes", () => {
    expect(normalizePhone("+254-712-345-678")).toBe("254712345678");
  });

  it("with parentheses", () => {
    expect(normalizePhone("(071)234-5678")).toBe("254712345678");
  });

  it("leading/trailing whitespace", () => {
    expect(normalizePhone("  0712345678  ")).toBe("254712345678");
  });

  it("2541 prefix (Safaricom 01XX range)", () => {
    expect(normalizePhone("0112345678")).toBe("254112345678");
  });

  it("rejects >32 char input", () => {
    const long = "0".repeat(33);
    expect(() => normalizePhone(long)).toThrow("mpesa: input too long");
  });

  it("rejects non-ASCII digit lookalikes (Arabic-Indic)", () => {
    // U+0660 ARABIC-INDIC DIGIT ZERO etc.
    expect(() => normalizePhone("\u0660\u0667\u0661\u0662\u0663\u0664\u0665\u0666\u0667\u0668")).toThrow(
      "mpesa:",
    );
  });

  it("rejects too-short number after normalization", () => {
    expect(() => normalizePhone("071234")).toThrow("mpesa:");
  });

  it("rejects number not starting with 1 or 7 after 254", () => {
    // 0812345678 → 254812345678 → fails regex (8 not in [17])
    expect(() => normalizePhone("0812345678")).toThrow("mpesa:");
  });

  it("rejects empty string", () => {
    expect(() => normalizePhone("")).toThrow("mpesa:");
  });
});

// ---------------------------------------------------------------------------
// securityCredential
// ---------------------------------------------------------------------------

describe("securityCredential", () => {
  const PASSWORD = "test-initiator-password";

  it("encrypts and returns valid base64 of expected length", () => {
    const cred = securityCredential(SANDBOX_CERT_PEM, PASSWORD);
    // RSA-2048 PKCS#1 v1.5 → 256 bytes → 344 base64 chars
    expect(typeof cred).toBe("string");
    expect(cred.length).toBeGreaterThan(300);
    expect(cred.length).toBeLessThanOrEqual(400);

    // Verify it's valid base64
    const decoded = Buffer.from(cred, "base64");
    expect(decoded.byteLength).toBe(256); // RSA-2048
  });

  it("accepts PEM string input", () => {
    const pemStr = SANDBOX_CERT_PEM.toString("utf-8");
    const cred = securityCredential(pemStr, PASSWORD);
    expect(cred).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("accepts Buffer input", () => {
    const cred = securityCredential(SANDBOX_CERT_PEM, PASSWORD);
    expect(typeof cred).toBe("string");
  });

  it("produces same-length ciphertext for same input (PKCS#1 v1.5 uses random padding)", () => {
    const cred1 = securityCredential(SANDBOX_CERT_PEM, PASSWORD);
    const cred2 = securityCredential(SANDBOX_CERT_PEM, PASSWORD);
    // Different ciphertexts (random padding), but same byte length
    expect(Buffer.from(cred1, "base64").byteLength).toBe(
      Buffer.from(cred2, "base64").byteLength,
    );
  });

  it("rejects empty password", () => {
    expect(() => securityCredential(SANDBOX_CERT_PEM, "")).toThrow(
      "mpesa: initiator_password is required",
    );
  });

  it("rejects whitespace-only password", () => {
    expect(() => securityCredential(SANDBOX_CERT_PEM, "   ")).toThrow(
      "mpesa: initiator_password is required",
    );
  });

  it("rejects invalid certificate", () => {
    expect(() => securityCredential("not-a-cert", PASSWORD)).toThrow(
      "mpesa: parse M-Pesa certificate",
    );
  });
});

// ---------------------------------------------------------------------------
// securityCredential hardening — RSA gate + 245-byte PKCS#1 v1.5 limit
// ---------------------------------------------------------------------------

describe("securityCredential hardening", () => {
  // Self-signed ECDSA P-256 fixture (public cert only — no private key
  // material). Generated for this test; parsing never checks dates/chains.
  const EC_CERT_PEM = [
    "-----BEGIN CERTIFICATE-----",
    "MIIBhjCCASygAwIBAgIQGqNIXcJuCbNO+LkDj+13ejAKBggqhkjOPQQDAjAcMRow",
    "GAYDVQQDDBFtcGVzYS1zZGstdGVzdC1lYzAeFw0yNjA5MTcwMzU1MjlaFw0zNjA5",
    "MTcwNDA1MjhaMBwxGjAYBgNVBAMMEW1wZXNhLXNkay10ZXN0LWVjMFkwEwYHKoZI",
    "zj0CAQYIKoZIzj0DAQcDQgAE4NdiMQ6OmZ04CJRiyqUJpDdu7TUAkP+5eGEMUACN",
    "RB6HoB50vEtcQQzF/95ms4zWH9HbW4LExtILSBs2l/cwdqNQME4wDgYDVR0PAQH/",
    "BAQDAgWgMB0GA1UdJQQWMBQGCCsGAQUFBwMCBggrBgEFBQcDATAdBgNVHQ4EFgQU",
    "qmX08aRRVhst8qcPTqx/3YsEodEwCgYIKoZIzj0EAwIDSAAwRQIhALLrIQd2UV+W",
    "ZUIgkVm04ZmhyvzKig4B+hzndN/fmWbVAiAJU2NHj2IJWEHds/JaCWrVCm7OKh9p",
    "pwB0TZikvT6x+A==",
    "-----END CERTIFICATE-----",
  ].join("\n");

  it("rejects EC certificates (Go *rsa.PublicKey / Python RSAPublicKey parity)", () => {
    expect(() => securityCredential(EC_CERT_PEM, "password")).toThrow(
      "mpesa: M-Pesa certificate carries non-RSA public key",
    );
  });

  it("rejects passwords over 245 UTF-8 bytes without echoing the secret", () => {
    const secret = `s3cr3t-${"x".repeat(300)}`; // 307 ASCII bytes
    expect(Buffer.from(secret, "utf-8").byteLength).toBeGreaterThan(245);
    let message = "";
    try {
      securityCredential(SANDBOX_CERT_PEM, secret);
      expect.fail("should have thrown");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/too long/);
    expect(message).toContain("245");
    expect(message).not.toContain("s3cr3t");
  });

  it("counts bytes, not chars: 123 × U+00E9 (246 bytes) throws", () => {
    const pw = "é".repeat(123); // 123 chars, 246 UTF-8 bytes
    expect(pw.length).toBe(123);
    expect(Buffer.from(pw, "utf-8").byteLength).toBe(246);
    expect(() => securityCredential(SANDBOX_CERT_PEM, pw)).toThrow(/246 bytes/);
  });

  it("accepts exactly 245-byte passwords (RSA-2048 PKCS#1 v1.5 boundary)", () => {
    const pw = "a".repeat(245);
    const cred = securityCredential(SANDBOX_CERT_PEM, pw);
    expect(Buffer.from(cred, "base64").byteLength).toBe(256);
  });
});

// ---------------------------------------------------------------------------
// securityCredential hardening — RSA key-size floor
// ---------------------------------------------------------------------------

/**
 * Minimal ASN.1 DER writer.
 *
 * Node's `crypto` generates an RSA key pair but exposes NO API for building
 * an X.509 certificate — `X509Certificate` parses, it cannot create — so a
 * weak-key fixture cannot be assembled from the public API alone. This
 * writes just enough DER to wrap a generated public key in a self-signed
 * certificate, which is all the SDK ever reads: it never checks the chain
 * or the validity dates.
 */
function der(tag: number, content: Buffer): Buffer {
  const len = content.length;
  let header: Buffer;
  if (len < 0x80) {
    header = Buffer.from([tag, len]);
  } else {
    const size: number[] = [];
    for (let n = len; n > 0; n = Math.floor(n / 256)) size.unshift(n & 0xff);
    header = Buffer.from([tag, 0x80 | size.length, ...size]);
  }
  return Buffer.concat([header, content]);
}

const derSeq = (...parts: Buffer[]): Buffer => der(0x30, Buffer.concat(parts));
const derSet = (...parts: Buffer[]): Buffer => der(0x31, Buffer.concat(parts));

function derInt(value: number): Buffer {
  const bytes: number[] = [];
  for (let n = value; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
  if ((bytes[0] ?? 0) & 0x80) bytes.unshift(0); // keep it positive
  return der(0x02, Buffer.from(bytes));
}

function derOID(oid: string): Buffer {
  const parts = oid.split(".").map(Number);
  const bytes: number[] = [(parts[0] ?? 0) * 40 + (parts[1] ?? 0)];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [];
    for (let n = part; n > 0; n = Math.floor(n / 7)) chunk.unshift(n & 0x7f);
    // Every byte but the last carries the "more bytes follow" bit.
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] = (chunk[i] ?? 0) | 0x80;
    bytes.push(...chunk);
  }
  return der(0x06, Buffer.from(bytes));
}

const derNull = (): Buffer => der(0x05, Buffer.alloc(0));
const derPrintableString = (s: string): Buffer => der(0x13, Buffer.from(s, "ascii"));
const derUTCTime = (s: string): Buffer => der(0x17, Buffer.from(s, "ascii"));
const derBitString = (content: Buffer): Buffer =>
  der(0x03, Buffer.concat([Buffer.from([0x00]), content]));

/**
 * Build a self-signed X.509 certificate around a freshly generated RSA key
 * of `bits` size.
 *
 * The weak key is generated HERE, in the test, so no weak key material is
 * ever committed to the repository.
 */
function selfSignedRSACert(bits: number): Buffer {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: bits,
  });
  const sha256WithRSA = derSeq(derOID("1.2.840.113549.1.1.11"), derNull());
  const name = derSeq(
    derSet(derSeq(derOID("2.5.4.3"), derPrintableString("mpesa-key-size-test"))),
  );
  const validity = derSeq(
    derUTCTime("200101000000Z"),
    derUTCTime("300101000000Z"),
  );
  const tbs = derSeq(
    der(0xa0, derInt(2)), // version v3
    derInt(1), // serial number
    sha256WithRSA, // signature algorithm
    name, // issuer
    validity,
    name, // subject
    publicKey.export({ type: "spki", format: "der" }),
  );
  const signature = sign("sha256", tbs, privateKey);
  return derSeq(tbs, sha256WithRSA, derBitString(signature));
}

describe("securityCredential RSA key-size floor", () => {
  it("rejects a 1024-bit RSA key and names the actual size", () => {
    // That key encrypts the initiator password on the wire, so a key this
    // weak is exactly what the 2048-bit floor exists to keep out.
    expect(() =>
      securityCredential(selfSignedRSACert(1024), "password"),
    ).toThrow("mpesa: M-Pesa certificate RSA key is 1024 bits, want at least 2048");
  });

  it("accepts a 2048-bit RSA key (the size the official certs ship)", () => {
    const cred = securityCredential(selfSignedRSACert(2048), "password");
    expect(Buffer.from(cred, "base64").byteLength).toBe(256);
  });

  it("reports the PASSWORD error first, not the weak-key error (go/py parity)", () => {
    // Go (go/helpers.go) and Python (python/mpesa/helpers.py) validate the
    // initiator password BEFORE the RSA key-size floor, so for the SAME bad
    // input — an empty password AND a weak certificate — all three engines
    // report the password error first. TypeScript used to apply the floor
    // first and named the key size instead.
    expect(() => securityCredential(selfSignedRSACert(1024), "")).toThrow(
      "mpesa: initiator_password is required",
    );
    expect(() => securityCredential(selfSignedRSACert(1024), "   ")).toThrow(
      "mpesa: initiator_password is required",
    );
  });
});

// ---------------------------------------------------------------------------
// newOriginatorID
// ---------------------------------------------------------------------------

describe("newOriginatorID", () => {
  it("returns 16 hex characters (matches Go/Python)", () => {
    const id = newOriginatorID();
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("produces unique values over 100 calls", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(newOriginatorID());
    }
    expect(ids.size).toBe(100);
  });

  it("each call is different (probabilistic, but 100 collisions impossible)", () => {
    const first = newOriginatorID();
    const second = newOriginatorID();
    expect(first).not.toBe(second);
  });
});
