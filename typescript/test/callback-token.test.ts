/**
 * Callback URL token primitives — mirrors go/callbacktoken.go truth table:
 * generation shape/uniqueness and constant-time comparison semantics.
 */
import { describe, it, expect } from "vitest";

import { newCallbackToken, callbackTokenEqual } from "../src/index.js";

// Direct-module import doubles as proof both entry paths resolve.
import {
  newCallbackToken as newCallbackTokenDirect,
  callbackTokenEqual as callbackTokenEqualDirect,
} from "../src/callback-token.js";

const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const TOKEN_LENGTH = 22;

describe("newCallbackToken", () => {
  it("produces exactly 22 unpadded base64url characters, every draw", () => {
    for (let i = 0; i < 1000; i++) {
      const tok = newCallbackToken();
      expect(tok.length).toBe(TOKEN_LENGTH);
      expect(tok).toMatch(TOKEN_RE);
    }
  });

  it("yields 1000 unique draws — no repeats across the entropy space", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      seen.add(newCallbackToken());
    }
    expect(seen.size).toBe(1000);
  });

  it("is re-exported identically by the barrel", () => {
    expect(newCallbackTokenDirect).toBe(newCallbackToken);
    expect(callbackTokenEqualDirect).toBe(callbackTokenEqual);
  });
});

describe("callbackTokenEqual", () => {
  it("true on exact match (generated token vs itself)", () => {
    for (let i = 0; i < 100; i++) {
      const tok = newCallbackToken();
      expect(callbackTokenEqual(tok, tok)).toBe(true);
    }
  });

  it("false on same-length mismatch", () => {
    expect(callbackTokenEqual("a".repeat(22), "b".repeat(22))).toBe(false);
  });

  it("false when BOTH sides are empty — unconfigured expectation must never bless a request", () => {
    expect(callbackTokenEqual("", "")).toBe(false);
  });

  it("false when only expected is empty", () => {
    expect(callbackTokenEqual("", newCallbackToken())).toBe(false);
  });

  it("false when only provided is empty", () => {
    expect(callbackTokenEqual(newCallbackToken(), "")).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(
      callbackTokenEqual("AbCdEfGhIjKlMnOpQrStUv", "aBcDeFgHiJkLmNoPqRsTuV"),
    ).toBe(false);
  });

  it("false on differing lengths (pre-guards timingSafeEqual's throw)", () => {
    expect(callbackTokenEqual("short", "longer-token")).toBe(false);
    expect(() => callbackTokenEqual("x".repeat(21), "y".repeat(22))).not.toThrow();
  });

  it("false on truncation — full token vs its own prefix", () => {
    const tok = newCallbackToken();
    expect(callbackTokenEqual(tok, tok.slice(0, TOKEN_LENGTH - 1))).toBe(false);
  });

  it("distinguishes independent draws (cross-comparison)", () => {
    for (let i = 0; i < 100; i++) {
      expect(callbackTokenEqual(newCallbackToken(), newCallbackToken())).toBe(false);
    }
  });
});

describe("barrel exports exist (type-level smoke)", () => {
  it("exposes both primitives as functions on index", () => {
    expect(typeof newCallbackToken).toBe("function");
    expect(typeof callbackTokenEqual).toBe("function");
  });
});
