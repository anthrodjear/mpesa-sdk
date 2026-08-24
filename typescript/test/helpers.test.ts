/**
 * Tests for src/helpers.ts — password generation, phone normalization,
 * RSA security credential, and originator ID.
 *
 * Mirrors go/helpers.go and python/mpesa/helpers.py with exact golden
 * vectors and identical edge-case coverage.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    const cred = securityCredential(PASSWORD, SANDBOX_CERT_PEM);
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
    const cred = securityCredential(PASSWORD, pemStr);
    expect(cred).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it("accepts Buffer input", () => {
    const cred = securityCredential(PASSWORD, SANDBOX_CERT_PEM);
    expect(typeof cred).toBe("string");
  });

  it("produces same-length ciphertext for same input (PKCS#1 v1.5 uses random padding)", () => {
    const cred1 = securityCredential(PASSWORD, SANDBOX_CERT_PEM);
    const cred2 = securityCredential(PASSWORD, SANDBOX_CERT_PEM);
    // Different ciphertexts (random padding), but same byte length
    expect(Buffer.from(cred1, "base64").byteLength).toBe(
      Buffer.from(cred2, "base64").byteLength,
    );
  });

  it("rejects empty password", () => {
    expect(() => securityCredential("", SANDBOX_CERT_PEM)).toThrow(
      "mpesa: initiator_password is required",
    );
  });

  it("rejects whitespace-only password", () => {
    expect(() => securityCredential("   ", SANDBOX_CERT_PEM)).toThrow(
      "mpesa: initiator_password is required",
    );
  });

  it("rejects invalid certificate", () => {
    expect(() => securityCredential(PASSWORD, "not-a-cert")).toThrow(
      "mpesa: parse M-Pesa certificate",
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
