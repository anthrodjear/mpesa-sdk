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
 * @packageDocumentation
 */

/**
 * Read `body` to a UTF-8 string but abort once `maxBytes` is exceeded.
 *
 * @param body     - The response stream (null tolerated for empty bodies).
 * @param label    - Path/label used in the error message.
 * @param maxBytes - Hard cap on accumulated bytes.
 * @returns The decoded body text.
 * @throws {Error} When the accumulated size exceeds `maxBytes`.
 */
export async function readBodyBounded(
  body: ReadableStream<Uint8Array> | null,
  label: string,
  maxBytes: number,
): Promise<string> {
  if (body === null) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength > 0) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new Error(`mpesa: ${label} response exceeds ${maxBytes} bytes`);
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
