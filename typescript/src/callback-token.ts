/**
 * Callback URL tokens: bearer capabilities hardening callback endpoints
 * against forged POSTs (mirrors go/callbacktoken.go). Threat model: Daraja
 * sends NO signature on callback traffic — anyone who learns/guesses your
 * CallBackURL can forge a body that parses cleanly, so treat the registered
 * URL path as a bearer capability: embed an unguessable token
 * (`https://api.example.com/mpesa/callback/<token>`) proving the caller
 * KNOWS the URL. It gates the ENDPOINT, NOT payload content; a hit never
 * replaces settlement — ALWAYS settle by query bound to YOUR record (forged
 * callbacks parse fine), e.g.
 * `if (parseInt((await client.stkQuery({ checkoutRequestID })).ResultCode, 10) === 0) markPaid(order);`
 * Scrub access logs/APM traces (the token rides in URLs); rotate long-lived
 * C2B registrations via an overlap window, retiring the old token once
 * traffic migrates.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * 128 bits — the floor for unguessable URL capabilities — encoding to
 * exactly 22 unpadded base64url characters.
 */
const CALLBACK_TOKEN_ENTROPY_BYTES = 16;

/**
 * Return a fresh URL-safe callback token: 22 characters carrying 128 bits
 * of entropy, encoded unpadded base64url.
 *
 * The source is Node's `node:crypto` CSPRNG — crypto-grade randomness,
 * mirroring Go's `crypto/rand` choice. Generate one per registered
 * CallBackURL (or per order), embed it in the URL path and store it beside
 * the request record for later comparison. Entropy failures propagate
 * verbatim: there is deliberately NO fallback to random/time-derived values,
 * because a guessable token silently converts every registered endpoint into
 * a forgery target. See the threat-model notes atop this module for logging,
 * rotation and settlement rules.
 */
export function newCallbackToken(): string {
  return randomBytes(CALLBACK_TOKEN_ENTROPY_BYTES).toString("base64url");
}

/**
 * Compare the token on file against the token on a request hit in constant
 * time; true only on exact equality.
 *
 * Either side falsy returns false immediately — including BOTH empty —
 * because an unconfigured expectation must never bless a request:
 * {@link timingSafeEqual} alone returns true for two empty inputs, which is
 * exactly backwards here. Differing lengths return false via a plain length
 * guard before comparing — that short-circuit is NOT constant time, but it
 * leaks only the public length (the token rides in the URL) and pre-empts
 * the exception {@link timingSafeEqual} throws on unequal buffers. Once
 * lengths match, comparison cost stays flat in byte equality.
 */
export function callbackTokenEqual(
  expected: string,
  provided: string,
): boolean {
  if (!expected || !provided) {
    return false;
  }
  if (expected.length !== provided.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(provided, "utf8"));
}
