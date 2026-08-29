import { generateKeyPair } from "@libp2p/crypto/keys";
import type { AbortOptions, PeerId, Stream } from "@libp2p/interface";
import { defaultLogger } from "@libp2p/logger";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { byteStream, streamPair } from "@libp2p/utils";
import { beforeAll, describe, expect, it } from "vitest";
import { createSign } from "../src/challenge.ts";
import type { Sign, SupportedPrivateKey } from "../src/challenge.ts";
import {
  authenticateToHandler,
  awaitHandlerClose,
  closeWrite,
} from "../src/dialer.ts";
import { authenticateDialer, readIpnsMultihash } from "../src/handler.ts";
import type { Allow } from "../src/handler.ts";
import type { IpnsMultihash, Libp2pKey } from "../src/interface.ts";
import { publicKeyToIpnsMultihash } from "../src/utils.ts";

const log = defaultLogger().forComponent("test");

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

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

// announce the key and prove ownership via the dialer handshake helper
async function runDialer(
  outbound: Stream,
  sign: Sign,
  signal: AbortSignal,
  timeoutMs = 5000,
  peerId: PeerId = handlerPeerId,
): Promise<void> {
  const bs = byteStream(outbound);
  await authenticateToHandler(bs, peerId, dialerIpns, sign, undefined, {
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
  const dialerIpns = await readIpnsMultihash(bs, log, { signal });
  const dialerLibp2pKey = await authenticateDialer(
    bs,
    handlerPeerId,
    dialerIpns,
    allow,
    log,
    { signal },
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

  it("does not run allow.multihash before the dialer has proven the key", async () => {
    let called = false;
    const allow: Allow = {
      multihash: () => {
        called = true;
        return true;
      },
      record: () => true,
    };
    const [outbound, inbound] = await streamPair();
    const signal = AbortSignal.timeout(1000);

    // announce a key and an empty auth frame, then go silent. Nothing has been
    // proven at this point, so an application callback must not run: it is the
    // expensive half of the handshake (a delegation chain check, a datastore
    // read) and anyone who can dial can reach it.
    const bs = byteStream(outbound);
    await bs.write(dialerIpns.bytes);
    await bs.write(Uint8Array.of(0));

    const handler = runHandler(inbound, allow, signal).catch(() => {});
    await delay(300);

    expect(called).toBe(false);

    outbound.abort(new Error("test done"));
    await handler;
  });

  it("rejects a dialer that signed for a different handler", async () => {
    const otherHandler = peerIdFromPrivateKey(
      (await generateKeyPair("Ed25519")) as SupportedPrivateKey,
    );
    const [outbound, inbound] = await streamPair();
    const signal = AbortSignal.timeout(5000);

    // the key and both nonces are right; only the handler the challenge is
    // bound to differs, which is what stops one handler relaying a response
    // it collected to another
    await expect(
      Promise.all([
        runDialer(outbound, createSign(dialerKey), signal, 5000, otherHandler),
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

    // the handshake completes, then the deny lands, so the dialer is left
    // waiting on the next step; abort it afterwards rather than leak a pending
    // promise
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
    const secpIpns = publicKeyToIpnsMultihash(secpKey.publicKey);
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
          undefined,
          { signal, timeoutMs: 5000, log },
        );
      })(),
      (async () => {
        const bs = byteStream(inbound);
        const ipns = await readIpnsMultihash(bs, log, { signal });
        return authenticateDialer(bs, handlerPeerId, ipns, allowAll, log, {
          signal,
        });
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

  it("resolves at once when the remote already closed its write side", async () => {
    const [outbound, inbound] = await streamPair();
    const signal = AbortSignal.timeout(5000);

    // the handler half-closes before the dialer waits, so the one-shot
    // remoteCloseWrite fires before awaitHandlerClose attaches its listener
    await inbound.close();
    await delay(50);

    // must short-circuit on the already-closed state, not hang to the ack timeout
    await expect(awaitHandlerClose(outbound, { signal, timeoutMs: 400, log }))
      .resolves
      .toBeUndefined();

    outbound.abort(new Error("test done"));
  });

  it("aborts the close on its deadline when the write side never drains", async () => {
    // streamPair has no backpressure, so its close() never blocks; model a
    // remote that stopped reading directly. close() honors its signal, mirroring
    // abstract-stream's `await pEvent(this, 'drain', { signal })`.
    const stuck = {
      close: (opts?: AbortOptions) =>
        new Promise<void>((_, reject) => {
          opts?.signal?.addEventListener("abort", () =>
            reject(opts.signal?.reason ?? new Error("aborted")));
        }),
    } as unknown as Stream;

    const start = Date.now();
    // generous caller backstop; the 50ms per-step deadline must fire well before
    await expect(
      closeWrite(stuck, {
        signal: AbortSignal.timeout(2000),
        timeoutMs: 50,
        log,
      }),
    )
      .rejects
      .toThrow();
    expect(Date.now() - start).toBeLessThan(500);
  });
});
