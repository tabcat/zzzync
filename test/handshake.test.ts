import { generateKeyPair } from "@libp2p/crypto/keys";
import type { PeerId, Stream } from "@libp2p/interface";
import { defaultLogger } from "@libp2p/logger";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { byteStream, streamPair } from "@libp2p/utils";
import { beforeAll, describe, expect, it } from "vitest";
import { createSign } from "../src/challenge.ts";
import type { Sign, SupportedPrivateKey } from "../src/challenge.ts";
import { authenticateToHandler, awaitHandlerClose } from "../src/dialer.ts";
import { authenticateDialer, readIpnsMultihash } from "../src/handler.ts";
import type { Allow } from "../src/handler.ts";
import type { IpnsMultihash, Libp2pKey } from "../src/interface.ts";
import { publicKeyAsIpnsMultihash } from "../src/utils.ts";

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

// announce the key and prove ownership via the dialer handshake helper
async function runDialer(
  outbound: Stream,
  sign: Sign,
  signal: AbortSignal,
  timeoutMs = 5000,
): Promise<void> {
  const bs = byteStream(outbound);
  await authenticateToHandler(bs, handlerPeerId, dialerIpns, sign, {
    signal,
    timeoutMs,
    log,
  });
}

// read the key, then authenticate - authenticateDialer no longer reads the
// multihash itself
const allowAll: Allow = { multihash: () => true, record: () => true };

async function runHandler(
  inbound: Stream,
  allow: Allow,
  signal: AbortSignal,
): Promise<{ dialerIpns: IpnsMultihash; dialerLibp2pKey: Libp2pKey; }> {
  const bs = byteStream(inbound);
  const dialerIpns = await readIpnsMultihash(bs, { signal });
  const dialerLibp2pKey = await authenticateDialer(
    bs,
    handlerPeerId,
    dialerIpns,
    allow,
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
      runHandler(inbound, allowAll, signal),
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
        runHandler(inbound, allowAll, signal),
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

    await expect(runHandler(inbound, allow, signal)).rejects.toThrow(
      "ipns key not allowed",
    );

    outbound.abort(new Error("test done"));
    await dialer;
  });

  it("authenticates a secp256k1 dialer", async () => {
    const secpKey = (await generateKeyPair("secp256k1")) as SupportedPrivateKey;
    const secpIpns = publicKeyAsIpnsMultihash(secpKey.publicKey);
    if (secpIpns == null) throw new Error("expected ipns multihash");
    const [outbound, inbound] = await streamPair();
    const signal = AbortSignal.timeout(5000);

    const [, key] = await Promise.all([
      (async () => {
        const bs = byteStream(outbound);
        await authenticateToHandler(
          bs,
          handlerPeerId,
          secpIpns,
          createSign(secpKey),
          { signal, timeoutMs: 5000, log },
        );
      })(),
      (async () => {
        const bs = byteStream(inbound);
        const ipns = await readIpnsMultihash(bs, { signal });
        return authenticateDialer(
          bs,
          handlerPeerId,
          ipns,
          allowAll,
          log,
          signal,
        );
      })(),
    ]);

    expect(key.equals(secpKey.publicKey.toCID())).toBe(true);
  });

  it("times out a handshake step when the handler never responds", async () => {
    const [outbound, inbound] = await streamPair();
    const signal = AbortSignal.timeout(5000);

    // the handler sends no nonce, so the dialer's nonce read hits its per-step
    // deadline well before the 5s backstop signal
    await expect(runDialer(outbound, createSign(dialerKey), signal, 50)).rejects
      .toThrow();

    inbound.abort(new Error("test done"));
  });

  it("times out awaiting the handler's close", async () => {
    const [outbound, inbound] = await streamPair();
    const signal = AbortSignal.timeout(5000);

    // nothing closes inbound's write side, so remoteCloseWrite never fires
    await expect(awaitHandlerClose(outbound, { signal, timeoutMs: 50, log }))
      .rejects
      .toThrow();

    inbound.abort(new Error("test done"));
  });
});
