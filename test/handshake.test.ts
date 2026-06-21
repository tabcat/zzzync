import { generateKeyPair } from "@libp2p/crypto/keys";
import type { PeerId, Stream } from "@libp2p/interface";
import { defaultLogger } from "@libp2p/logger";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { byteStream, streamPair } from "@libp2p/utils";
import { beforeAll, describe, expect, it } from "vitest";
import { createSign } from "../src/challenge.js";
import type { Sign, SupportedPrivateKey } from "../src/challenge.js";
import { completeChallenge, writeIpnsMultihash } from "../src/dialer.js";
import { authenticateDialer, readIpnsMultihash } from "../src/handler.js";
import type { Allow, CreateHandlerOptions } from "../src/handler.js";
import type { IpnsMultihash, Libp2pKey } from "../src/interface.js";
import { publicKeyAsIpnsMultihash } from "../src/utils.js";

const log = defaultLogger().forComponent("test");

let handlerPeerId: PeerId;
let dialerKey: SupportedPrivateKey;
let dialerIpns: IpnsMultihash;

beforeAll(async () => {
  handlerPeerId = peerIdFromPrivateKey(await generateKeyPair("Ed25519"));
  dialerKey = (await generateKeyPair("Ed25519")) as SupportedPrivateKey;
  const ipns = publicKeyAsIpnsMultihash(dialerKey.publicKey);
  if (ipns == null) throw new Error("expected ipns multihash");
  dialerIpns = ipns;
});

// announce the key, then complete the challenge - completeChallenge no longer
// sends the multihash itself
async function runDialer(
  outbound: Stream,
  sign: Sign,
  signal: AbortSignal,
): Promise<void> {
  const bs = byteStream(outbound);
  await writeIpnsMultihash(bs, dialerIpns, { signal });
  await completeChallenge(bs, handlerPeerId, dialerIpns, sign, log, signal);
}

// read the key, then authenticate - authenticateDialer no longer reads the
// multihash itself
async function runHandler(
  inbound: Stream,
  options: CreateHandlerOptions,
  signal: AbortSignal,
): Promise<{ dialerIpns: IpnsMultihash; dialerLibp2pKey: Libp2pKey; }> {
  const bs = byteStream(inbound);
  const dialerIpns = await readIpnsMultihash(bs, { signal });
  const dialerLibp2pKey = await authenticateDialer(
    bs,
    handlerPeerId,
    dialerIpns,
    options,
    log,
    signal,
  );
  return { dialerIpns, dialerLibp2pKey };
}

describe("handshake", () => {
  it("authenticates a dialer that proves key ownership", async () => {
    const [outbound, inbound] = await streamPair();
    const signal = AbortSignal.timeout(5000);

    const [, auth] = await Promise.all([
      runDialer(outbound, createSign(dialerKey), signal),
      runHandler(inbound, {}, signal),
    ]);

    expect(auth.dialerIpns.bytes).toEqual(dialerIpns.bytes);
    expect(auth.dialerLibp2pKey.equals(dialerKey.publicKey.toCID())).toBe(true);
  });

  it("rejects a response signed with the wrong key", async () => {
    const wrongKey = (await generateKeyPair("Ed25519")) as SupportedPrivateKey;
    const [outbound, inbound] = await streamPair();
    const signal = AbortSignal.timeout(5000);

    await expect(
      Promise.all([
        runDialer(outbound, createSign(wrongKey), signal),
        runHandler(inbound, {}, signal),
      ]),
    )
      .rejects
      .toThrow("Dialer challenge response invalid");
  });

  it("rejects a dialer the allow function denies", async () => {
    const allow: Allow = { multihash: () => false, record: () => true };
    const [outbound, inbound] = await streamPair();
    const signal = AbortSignal.timeout(5000);

    // the handler denies before writing its nonce, leaving the dialer waiting,
    // so abort it afterwards to avoid leaking a pending promise
    const dialer = runDialer(outbound, createSign(dialerKey), signal).catch(
      () => {},
    );

    await expect(runHandler(inbound, { allow }, signal)).rejects.toThrow(
      "ipns key not allowed",
    );

    outbound.abort(new Error("test done"));
    await dialer;
  });
});
