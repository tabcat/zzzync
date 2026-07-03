import type { Stream } from "@libp2p/interface";
import { byteStream, streamPair } from "@libp2p/utils";
import * as varint from "uint8-varint";
import { Uint8ArrayList } from "uint8arraylist";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_AUTH_FRAME_BYTES } from "../src/constants.ts";
import { readAuth } from "../src/handler.ts";

async function writeFrame(stream: Stream, payload: Uint8Array): Promise<void> {
  await byteStream(stream).write(
    new Uint8ArrayList(varint.encode(payload.length), payload),
  );
}

describe("readAuth", () => {
  it("returns undefined for a zero-length frame", async () => {
    const [outbound, inbound] = await streamPair();
    const [, result] = await Promise.all([
      writeFrame(outbound, new Uint8Array(0)),
      readAuth(byteStream(inbound), DEFAULT_MAX_AUTH_FRAME_BYTES),
    ]);
    expect(result).toBeUndefined();
  });

  it("returns the payload bytes for a non-empty frame", async () => {
    const [outbound, inbound] = await streamPair();
    const payload = new Uint8Array([1, 2, 3, 4]);
    const [, result] = await Promise.all([
      writeFrame(outbound, payload),
      readAuth(byteStream(inbound), DEFAULT_MAX_AUTH_FRAME_BYTES),
    ]);
    expect(result).toEqual(payload);
  });

  it("throws when the declared length exceeds maxBytes", async () => {
    const [outbound, inbound] = await streamPair();
    await byteStream(outbound).write(
      new Uint8ArrayList(varint.encode(DEFAULT_MAX_AUTH_FRAME_BYTES + 1)),
    );
    await expect(readAuth(byteStream(inbound), DEFAULT_MAX_AUTH_FRAME_BYTES))
      .rejects
      .toThrow("auth frame exceeds max size");
  });
});
