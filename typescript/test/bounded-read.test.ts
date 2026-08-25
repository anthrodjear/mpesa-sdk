import { describe, expect, it } from "vitest";
import { readBodyBounded } from "../src/_bounded-read.js";

function fromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) { controller.enqueue(bytes); controller.close(); },
  });
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
});
