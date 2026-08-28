import { generateKeyPair } from "@libp2p/crypto/keys";
import type { PeerId, Stream } from "@libp2p/interface";
import { defaultLogger } from "@libp2p/logger";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { byteStream, streamPair } from "@libp2p/utils";
import * as varint from "uint8-varint";
import { Uint8ArrayList } from "uint8arraylist";
import { beforeAll, describe, expect, it } from "vitest";
import { createSign } from "../src/challenge.ts";
import type { SupportedPrivateKey } from "../src/challenge.ts";
import { DEFAULT_MAX_AUTH_FRAME_BYTES } from "../src/constants.ts";
import { authenticateToHandler } from "../src/dialer.ts";
import {
  authenticateDialer,
  readAuth,
  readIpnsMultihash,
} from "../src/handler.ts";
import type { Allow } from "../src/handler.ts";
import type { IpnsMultihash } from "../src/interface.ts";
import { publicKeyToIpnsMultihash } from "../src/utils.ts";

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

const log = defaultLogger().forComponent("test");

let handlerPeerId: PeerId;
let dialerKey: SupportedPrivateKey;
let dialerIpns: IpnsMultihash;

beforeAll(async () => {
  handlerPeerId = peerIdFromPrivateKey(await generateKeyPair("Ed25519"));
  dialerKey = (await generateKeyPair("Ed25519")) as SupportedPrivateKey;
  const ipns = publicKeyToIpnsMultihash(dialerKey.publicKey);
  if (ipns == null) throw new Error("expected ipns multihash");
  dialerIpns = ipns;
});

async function runHandshake(
  auth?: () => Uint8Array | Promise<Uint8Array>,
): Promise<Uint8Array | undefined> {
  const [outbound, inbound] = await streamPair();
  const signal = AbortSignal.timeout(5000);
  let received: Uint8Array | undefined;
  const allow: Allow = {
    multihash: (_pk, options) => {
      received = options?.auth;
      return true;
    },
    record: () => true,
  };
  await Promise.all([
    authenticateToHandler(
      byteStream(outbound),
      handlerPeerId,
      dialerIpns,
      createSign(dialerKey),
      auth,
      { signal, timeoutMs: 5000, log },
    ),
    (async () => {
      const bs = byteStream(inbound);
      const ipns = await readIpnsMultihash(bs, log, { signal });
      await authenticateDialer(bs, handlerPeerId, ipns, allow, log, { signal });
    })(),
  ]);
  return received;
}

describe("auth frame handshake", () => {
  it("delivers the auth frame to allow.multihash", async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const received = await runHandshake(async () => bytes);
    expect(received).toEqual(bytes);
  });

  it("passes undefined auth when the dialer sends no frame", async () => {
    const received = await runHandshake();
    expect(received).toBeUndefined();
  });
});
