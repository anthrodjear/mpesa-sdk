/**
 * Cross-engine conformance harness.
 *
 * Reads the shared fixtures in `contract/fixtures` (schema:
 * `contract/README.md`) and asserts the TypeScript engine agrees with the
 * contract. The same files are read by `go/contract_test.go` and
 * `python/tests/test_contract.py`; a case that passes in one engine and
 * fails in another is a DRIFT BUG in the failing engine, not a bad fixture.
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
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseSTKCallback } from "../src/callbacks.js";
import { parseBalanceSegments } from "../src/types.js";
import { MpesaError } from "../src/errors.js";

// The test directory is <repo>/typescript/test, so two levels up is the
// repository root where the shared corpus lives.
const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, "..", "..", "contract", "fixtures");

interface ContractCase {
  id: string;
  kind: string;
  body: unknown;
  expect: {
    class?: string;
    resultCode?: string;
    metadata?: Record<string, unknown>;
    errorCode?: string | null;
    errorMessage?: string | null;
    statusCode?: number;
    segments?: number;
    skipped?: number;
  };
}

function loadCases(): ContractCase[] {
  const files = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith(".json")).sort();
  if (files.length === 0) throw new Error(`no contract fixtures in ${FIXTURE_DIR}`);
  return files.map((f) =>
    JSON.parse(readFileSync(join(FIXTURE_DIR, f), "utf-8")) as ContractCase);
}

/**
 * The text the engine must SEE for a fixture body.
 *
 * A JSON string body IS the raw body text (a WAF page, an HTML error
 * page); an object body is the raw JSON document. Go and Python apply the
 * same rule, so one corpus can express both a JSON envelope and a
 * non-JSON gateway response.
 */
function rawBody(body: unknown): string {
  return typeof body === "string" ? body : JSON.stringify(body);
}

/**
 * A metadata value as a comparable number, or null when it is not one.
 *
 * Booleans are NOT numbers here: `true` must never compare equal to 1, and
 * a boolean metadata value is compared as a string instead.
 */
function asNumber(value: unknown): number | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return value.trim() !== "" && Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

describe("contract fixtures", () => {
  for (const c of loadCases()) {
    it(c.id, () => {
      switch (c.kind) {
        case "stk_callback": {
          const res = parseSTKCallback(rawBody(c.body));
          expect(String(res.classify())).toBe(c.expect.class);
          expect(res.ResultCode).toBe(c.expect.resultCode);
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
          const text = (c.body as { text: string }).text;
          const segments = parseBalanceSegments(text);
          expect(segments.length).toBe(c.expect.segments);
          // The skipped counter is Go/Python-only: parseBalanceSegments
          // returns ONLY the kept rows, so "skipped" is not observable
          // here. A regression that dropped every row would still satisfy
          // this assertion — the count is pinned by the other two engines.
          break;
        }
        case "error_envelope": {
          const err = MpesaError.fromResponse(c.expect.statusCode ?? 400, rawBody(c.body));
          expect(err.statusCode).toBe(c.expect.statusCode);
          expect(err.errorCode).toBe(c.expect.errorCode ?? null);
          expect(err.errorMessage).toBe(c.expect.errorMessage ?? null);
          break;
        }
        default:
          throw new Error(`unknown fixture kind ${c.kind}`);
      }
    });
  }
});
