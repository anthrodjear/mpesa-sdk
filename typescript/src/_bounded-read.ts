/**
 * Internal bounded response-body reader shared by `auth.ts` and `client.ts`.
 * NOT exported from the package barrel — import it inside `src/` via
 * `"./_bounded-read.js"` only.
 *
 * Parity: go `io.ReadAll(io.LimitReader(body, maxBytes+1))`. Accumulates
 * stream chunks and aborts the moment the running byte total exceeds
 * `maxBytes` — an oversized body is never fully materialized, even when no
 * honest Content-Length header is present.
 *
 * **Abort-aware**: callers pass the request's `AbortSignal` so the reader
 * races each `read()` against it. Without this, the timeout cleared the
 * timer when the response HEADERS resolved, and a server that trickles the
 * body afterwards left the returned promise pending forever. On abort the
 * reader is cancelled and a typed timeout {@link MpesaError} (HTTP 408)
 * rejects — the body read now lives inside the request timeout budget.
 *
 * @packageDocumentation
 */

import { MpesaError } from "./errors.js";

/**
 * Typed timeout rejection for a stalled body read. 408 (Request Timeout)
 * is the honest HTTP analogue for "headers arrived, body never finished".
 * Message renders as `mpesa: HTTP 408 <label> response body read timed out`.
 */
function bodyTimeoutError(label: string): MpesaError {
  return new MpesaError(408, null, null, `${label} response body read timed out`);
}

/**
 * Typed over-cap rejection for an oversized body. 413 (Content Too Large)
 * is the honest HTTP analogue for "the body exceeds the transport cap" —
 * the same 4xx-typed precedent as the 408 timeout in
 * {@link bodyTimeoutError}, so `catch (e instanceof MpesaError)` sees
 * oversize like any other failure mode. Message renders as
 * `mpesa: HTTP 413 <label> response exceeds <maxBytes> bytes`.
 *
 * @param label - Path/label used in the error message.
 * @param maxBytes - The cap that was exceeded.
 * @param actual - Claimed size (Content-Length guard), appended when known.
 */
export function bodyTooLargeError(label: string, maxBytes: number, actual?: number): MpesaError {
  return new MpesaError(
    413,
    null,
    null,
    actual !== undefined
      ? `${label} response exceeds ${maxBytes} bytes (Content-Length: ${actual})`
      : `${label} response exceeds ${maxBytes} bytes`,
  );
}
/**
 * One awaited `reader.read()` result. `value` is typed `| undefined`
 * (not just optional) so the Node `ReadableStreamReadDoneResult` union
 * stays assignable under `exactOptionalPropertyTypes`.
 */
type ReadStep = { done: boolean; value?: Uint8Array | undefined };
/**
 * Promise wrapper: settles as soon as `read` settles, but rejects with the
 * typed timeout error the moment `signal` fires. The abort listener is
 * `once` + removed on settle, so no listener leaks across chunk reads.
 */
function raceAbort(
  read: Promise<ReadStep>,
  signal: AbortSignal,
  label: string,
): Promise<ReadStep> {
  return new Promise((resolve, reject) => {
    // Synchronous already-aborted check: an abort landing between the
    // caller's `signal.aborted` check and this listener registration would
    // otherwise never fire `onAbort` (the event already fired) and the
    // wrapper would hang on a stalled read forever.
    if (signal.aborted) {
      reject(bodyTimeoutError(label));
      return;
    }
    const onAbort = () => reject(bodyTimeoutError(label));
    signal.addEventListener("abort", onAbort, { once: true });
    read.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Read `body` to a UTF-8 string but abort once `maxBytes` is exceeded.
 *
 * @param body     - The response stream (null tolerated for empty bodies).
 * @param label    - Path/label used in the error message.
 * @param maxBytes - Hard cap on accumulated bytes.
 * @param signal   - Optional request AbortSignal; when it fires mid-body the
 *   reader is cancelled and the promise rejects with a typed timeout error
 *   instead of hanging on a stalled stream.
 * @returns The decoded body text.
 * @throws {MpesaError} When the accumulated size exceeds `maxBytes`, or the
 *   signal fires while the body is still streaming (HTTP 408 timeout).
 */
export async function readBodyBounded(
  body: ReadableStream<Uint8Array> | null,
  label: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string> {
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw bodyTimeoutError(label);
      const pending = reader.read();
      let step: ReadStep;
      try {
        step = signal === undefined ? await pending : await raceAbort(pending, signal, label);
      } catch (err) {
        // Abort (or stream error) mid-read: cancel so the stalled upstream
        // socket/stream is released and the pending read can never leak.
        await reader.cancel().catch(() => { /* already errored/closed */ });
        throw err;
      }
      const { done, value } = step;
      if (done) break;
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw bodyTooLargeError(label, maxBytes);
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(merged);
}
