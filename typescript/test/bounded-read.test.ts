import { describe, expect, it } from "vitest";
import { readBodyBounded } from "../src/_bounded-read.js";
import { MpesaError } from "../src/errors.js";

function fromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  });
}

/** A stream that delivers one chunk then stalls forever (header-then-trickle). */
function stalledAfterFirstChunk(first: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) { controller.enqueue(first); /* never closes */ },
  });
}

/** Abort `controller` after `ms` unless the caller aborts first. */
function abortAfter(ms: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}

describe("readBodyBounded", () => {
  it("decodes valid UTF-8", async () => {
    const input = new TextEncoder().encode("hello");
    const result = await readBodyBounded(fromBytes(input), "test", 1024);
    expect(result).toBe("hello");
  });

  it("does NOT throw on invalid UTF-8 bytes", async () => {
    const invalid = new Uint8Array([0x48, 0x69, 0xff, 0xfe, 0x21]);
    const result = await readBodyBounded(fromBytes(invalid), "test", 1024);
    expect(result).toContain("Hi");
  });

  it("throws when body exceeds maxBytes", async () => {
    const big = new Uint8Array(200);
    await expect(readBodyBounded(fromBytes(big), "test", 100)).rejects.toThrow("exceeds");
  });

  it("the over-cap rejection is a typed MpesaError (HTTP 413)", async () => {
    const big = new Uint8Array(200);
    let caught: unknown;
    try {
      await readBodyBounded(fromBytes(big), "test", 100);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MpesaError);
    expect((caught as MpesaError).statusCode).toBe(413);
  });

  it("rejects a stalled mid-body stream with a typed timeout error when the signal fires", async () => {
    const { signal, cancel } = abortAfter(30);
    const stream = stalledAfterFirstChunk(new TextEncoder().encode('{"a":'));

    await expect(readBodyBounded(stream, "/test", 1024, signal)).rejects.toThrow(
      /response body read timed out/,
    );
    cancel();
  });

  it("the stalled-body rejection is a typed MpesaError (HTTP 408)", async () => {
    const { signal, cancel } = abortAfter(30);
    const stream = stalledAfterFirstChunk(new TextEncoder().encode("x"));

    let caught: unknown;
    try {
      await readBodyBounded(stream, "/test", 1024, signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MpesaError);
    expect((caught as MpesaError).statusCode).toBe(408);
    cancel();
  });

  it("an already-aborted signal rejects immediately without hanging", async () => {
    const controller = new AbortController();
    controller.abort();
    let caught: unknown;
    try {
      await readBodyBounded(stalledAfterFirstChunk(new TextEncoder().encode("x")), "/test", 1024, controller.signal);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MpesaError);
    expect((caught as MpesaError).statusCode).toBe(408);
  });

  it("rejects when abort lands between the aborted-check and listener registration", async () => {
    // The signal fires synchronously INSIDE read() — i.e. after the loop's
    // `signal.aborted` check but before raceAbort registers its listener.
    // Without the synchronous check in the raceAbort executor the wrapper
    // would hang on the never-settling read forever.
    const controller = new AbortController();
    const reader = {
      read: (): Promise<never> => {
        controller.abort();
        return new Promise<never>(() => { /* stalls forever */ });
      },
      cancel: async (): Promise<void> => {},
      releaseLock: (): void => {},
    };
    const body = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
    const outcome = await Promise.race([
      readBodyBounded(body, "/test", 1024, controller.signal).then(
        () => "resolved" as const,
        (err: unknown) => err,
      ),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timed out: raceAbort hung on an already-fired abort")), 1000),
      ),
    ]);
    expect(outcome).toBeInstanceOf(MpesaError);
    expect((outcome as MpesaError).statusCode).toBe(408);
  });
});
