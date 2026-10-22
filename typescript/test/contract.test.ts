/**
 * Cross-engine conformance harness.
 *
 * Reads the shared fixtures in `contract/fixtures` (schema:
 * `contract/README.md`) and asserts the TypeScript engine agrees with the
 * contract. The same files are read by `go/contract_test.go` and
 * `python/tests/test_contract.py`; a case that passes in one engine and
 * fails in another is either an engine drift bug or a wrong expectation —
 * decide which by checking the Daraja wire contract (`docs/apis/`), then
 * fix whichever is wrong.
 *
 * ONE CASE IS RED ON PURPOSE -- it pins a live defect, and this phase does
 * not fix it:
 *
 * - `error-envelope-unparseable` (**D7**) -- `MpesaError.fromResponse`
 *   embeds a 200-character snippet of the raw upstream body in the
 *   exception text. Go (`go/errors.go`) and Python
 *   (`mpesa/exceptions.py`) deliberately DISCARD that body: an exception
 *   object is logged by every `logger.exception` on the call path, so
 *   embedding upstream bytes ships raw gateway payloads (customer MSISDNs,
 *   WAF internals) to whatever log sink happens to be configured. The
 *   contract expects the generic "unexpected error response from gateway"
 *   message instead.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseSTKCallback } from "../src/callbacks.js";
import { parseBalanceSegments } from "../src/types.js";
import { MpesaError } from "../src/errors.js";

// The test directory is <repo>/typescript/test, so two levels up is the
// repository root where the shared corpus lives.
const FIXTURE_DIR = join(import.meta.dirname, "..", "..", "contract", "fixtures");

interface ContractCase {
  id: string;
  kind: string;
  /**
   * An INPUT -- the HTTP status the harness feeds the engine -- not an
   * expectation. Asserting that the engine echoed back the status it was
   * given can never fail, so it is not asserted on.
   */
  statusCode?: number;
  body: unknown;
  expect: {
    class?: string;
    resultCode?: string;
    metadata?: Record<string, unknown>;
    errorCode?: string | null;
    errorMessage?: string | null;
    segments?: number;
    skipped?: number;
  };
}

/**
 * Read the corpus.
 *
 * A fixture that does not decode names ITSELF in the failure -- a bare
 * SyntaxError would point at nothing. Fixture ids must be UNIQUE: a
 * duplicate would produce two identically named tests, and only one of them
 * would be read as the case the author meant.
 */
function loadCases(): ContractCase[] {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) throw new Error(`no contract fixtures in ${FIXTURE_DIR}`);
  const cases: ContractCase[] = [];
  const seen = new Map<string, string>();
  for (const f of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf-8"));
    } catch (err) {
      throw new Error(`decode ${f}: ${(err as Error).message}`);
    }
    const c = parsed as ContractCase;
    if (!c.id) {
      throw new Error(`fixture ${f} has no id`);
    }
    const prev = seen.get(c.id);
    if (prev !== undefined) {
      throw new Error(`duplicate fixture id "${c.id}" in ${prev} and ${f}`);
    }
    seen.set(c.id, f);
    cases.push(c);
  }
  return cases;
}

/**
 * A required expectation, or a loud failure naming the fixture.
 *
 * A fixture that forgets an expectation is a BROKEN fixture: reading it as
 * `undefined` would let the case pass while asserting nothing.
 */
function requireExpect<K extends keyof ContractCase["expect"]>(
  c: ContractCase,
  key: K,
): Exclude<ContractCase["expect"][K], undefined> {
  const value = c.expect[key];
  if (value === undefined) {
    throw new Error(`fixture ${c.id} has no expect.${key}`);
  }
  return value as Exclude<ContractCase["expect"][K], undefined>;
}

/**
 * The fixture body, or a loud failure naming the fixture.
 *
 * EVERY kind goes through this check, so a fixture with no body fails with
 * the same message in all three engines — and never feeds an engine an
 * empty body, an input no gateway ever sent.
 */
function requireBody(c: ContractCase): unknown {
  if (c.body === undefined) {
    throw new Error(`fixture ${c.id} has no body`);
  }
  return c.body;
}

/**
 * The text the engine must SEE for a fixture body.
 *
 * A JSON string body IS the raw body text (a WAF page, an HTML error
 * page); an object body is the raw JSON document. Go and Python apply the
 * same rule, so one corpus can express both a JSON envelope and a
 * non-JSON gateway response.
 */
function rawBody(c: ContractCase): string {
  const body = requireBody(c);
  return typeof body === "string" ? body : JSON.stringify(body);
}

/**
 * The content type the transport would have reported for the raw body.
 *
 * Derived from the RAW TEXT, exactly as the Go and Python harnesses derive
 * it: skip the leading ASCII whitespace, then look at the first byte. A
 * body that opens with a JSON object or array is `application/json`;
 * anything else (a WAF page, an HTML error page, a bare scalar) is
 * `text/html`.
 *
 * The fixture's JSON TYPE must not decide this: a fixture `body` that is
 * the string `"42"` IS the raw wire text `42`, which is not JSON.
 * Deriving from the type instead would have the TypeScript engine receive
 * a different input than the other two for the same fixture.
 */
function contentType(raw: string): string {
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch !== " " && ch !== "\t" && ch !== "\r" && ch !== "\n") break;
    i += 1;
  }
  const text = raw.slice(i);
  return text.startsWith("{") || text.startsWith("[")
    ? "application/json"
    : "text/html";
}

/**
 * Plain-decimal grammar: optional sign, digits, optional fractional part.
 *
 * Deliberately plain-decimal-only. `Number()` also accepts `"0x10"`, `"1e3"`,
 * `"Infinity"` and `""`, Python's `float()` also accepts `"inf"` and
 * `"nan"`, and Go's `strconv.ParseFloat` also accepts `"Inf"`, `"NaN"` and
 * `"0x1p-2"` — three permissive parsers would classify the same metadata
 * text three different ways. One grammar, applied identically in all three
 * harnesses, removes that class of drift by construction.
 */
const NUMERIC_RE = /^-?\d+(\.\d+)?$/;

/**
 * A metadata value as a comparable number, or null when it is not one.
 *
 * A JSON number is numeric. A STRING is numeric only when its trimmed text
 * matches the plain-decimal grammar. Everything else compares as a string.
 *
 * Booleans are NOT numbers here: `true` must never compare equal to 1, and
 * a boolean metadata value is compared as a string instead.
 */
function asNumber(value: unknown): number | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const text = value.trim();
    if (!NUMERIC_RE.test(text)) return null;
    const parsed = Number(text);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

describe("contract fixtures", () => {
  for (const c of loadCases()) {
    it(c.id, () => {
      switch (c.kind) {
        case "stk_callback": {
          const res = parseSTKCallback(rawBody(c));
          expect(String(res.classify())).toBe(requireExpect(c, "class"));
          expect(res.ResultCode).toBe(requireExpect(c, "resultCode"));
          for (const [key, want] of Object.entries(c.expect.metadata ?? {})) {
            const got = res.metadata().get(key);
            expect(got, `metadata[${key}] missing`).toBeDefined();
            const wantNum = asNumber(want);
            const gotNum = asNumber(got);
            if (wantNum !== null && gotNum !== null) {
              // The gateway sends Amount as 100 in one capture and as "100"
              // in another; both mean the same money.
              expect(gotNum).toBe(wantNum);
            } else {
              expect(String(got).trim()).toBe(String(want).trim());
            }
          }
          break;
        }
        case "balance_segment": {
          // Routed through the same body check as the other kinds, so a
          // fixture with no body fails with the same message in all three
          // engines.
          const body = requireBody(c) as { text?: unknown };
          if (typeof body.text !== "string") {
            throw new Error(`fixture ${c.id} has no body.text`);
          }
          const segments = parseBalanceSegments(body.text);
          expect(segments.length).toBe(requireExpect(c, "segments"));
          // The skipped counter is Go/Python-only: parseBalanceSegments
          // returns ONLY the kept rows, so "skipped" is not observable
          // here. A regression that dropped every row would still satisfy
          // this assertion — the count is pinned by the other two engines.
          break;
        }
        case "error_envelope": {
          // statusCode is an INPUT -- the HTTP status the harness feeds the
          // engine -- not an expectation, so it is never asserted on. 0 is
          // not a real HTTP status, so an absent AND a zero value are both
          // rejected: the three harnesses must agree on what a valid input
          // is.
          const status = c.statusCode;
          if (status === undefined || status === 0) {
            throw new Error(
              `fixture ${c.id} has no valid top-level statusCode: ${String(status)}`,
            );
          }
          const raw = rawBody(c);
          const err = MpesaError.fromResponse(status, raw, contentType(raw));
          expect(err.errorCode).toBe(requireExpect(c, "errorCode") ?? null);
          expect(err.errorMessage).toBe(requireExpect(c, "errorMessage") ?? null);
          break;
        }
        default:
          throw new Error(`unknown fixture kind ${c.kind}`);
      }
    });
  }
});

it("numeric grammar rejects non-plain decimals", () => {
  // The grammar is a LOCAL helper, so it needs its own test: a future
  // swap for Number() -- which also accepts "0x10", "1e3" and
  // "Infinity" -- would silently re-open the cross-engine divergence the
  // grammar exists to close, with TypeScript calling "1e3" a number
  // while Go and Python do not.
  for (const text of ["1e3", "0x10", "Inf", "NaN", "1_000"]) {
    expect(asNumber(text), text).toBeNull();
  }
  expect(asNumber("100")).toBe(100);
  expect(asNumber("-100")).toBe(-100);
  expect(asNumber("100.50")).toBe(100.5);
  // A JSON number is numeric by construction, whatever its magnitude.
  expect(asNumber(100)).toBe(100);
  // Booleans are not numbers: true must never compare equal to 1.
  expect(asNumber(true)).toBeNull();
});
