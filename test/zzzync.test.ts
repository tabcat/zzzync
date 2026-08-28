import { car } from "@helia/car";
import { unixfs } from "@helia/unixfs";
import { generateKeyPair } from "@libp2p/crypto/keys";
import type { Connection, PeerId } from "@libp2p/interface";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { streamPair } from "@libp2p/utils";
import { createHelia } from "helia";
import type { Helia } from "helia";
import { createIPNSRecord } from "ipns";
import type { CID } from "multiformats/cid";
import sinon from "sinon";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { createSign } from "../src/challenge.ts";
import type { SupportedPrivateKey } from "../src/challenge.ts";
import { zzzync } from "../src/dialer.ts";
import { createZzzyncHandler } from "../src/handler.ts";
import type {
  Allow,
  CarLimits,
  CreateHandlerOptions,
  OnReceive,
} from "../src/handler.ts";

// the protocol tests are not about size caps; @ipld/car rejects Infinity for
// its two, so those take its own defaults
const UNCAPPED: CarLimits = {
  maxByteLength: Infinity,
  maxBlockCount: Infinity,
  maxCarSectionSize: 8 * 1024 * 1024,
  maxCarHeaderSize: 32 * 1024 * 1024,
};
import type { PushInput } from "../src/interface.ts";
import {
  publicKeyFromIpnsMultihash,
  publicKeyToIpnsMultihash,
} from "../src/utils.ts";

// shared fixtures
let helia: Helia;
let dialerKey: SupportedPrivateKey;
let handlerPeerId: PeerId;
let contentCid: CID;
let result: PushInput;

beforeAll(async () => {
  helia = await createHelia();
  const fs = unixfs(helia);
  contentCid = await fs.addBytes(
    new TextEncoder().encode("zzzync test content"),
  );
  dialerKey = (await generateKeyPair("Ed25519")) as SupportedPrivateKey;
  handlerPeerId = peerIdFromPrivateKey(await generateKeyPair("Ed25519"));
  const record = await createIPNSRecord(dialerKey, contentCid, 0, 3_600_000);
  result = { record, publicKey: dialerKey.publicKey };
});

afterAll(async () => {
  await helia.stop();
});

// per-test
let mockImporter: {
  import: (arg: { blocks: () => AsyncIterable<unknown>; }) => Promise<void>;
};
let onReceive: sinon.SinonStub;
let connection: Connection;

beforeEach(() => {
  onReceive = sinon.stub().resolves();
  // consume blocks so the CAR generator runs
  mockImporter = {
    import: async ({ blocks }) => {
      for await (const _ of blocks()) { /* drain */ }
    },
  };
  connection = {
    remotePeer: peerIdFromPrivateKey(dialerKey),
  } as unknown as Connection;
});

afterEach(() => {
  sinon.restore();
});

const allowAll: Allow = { multihash: () => true, record: () => true };

function makeHandler(allow: Allow = allowAll, options?: CreateHandlerOptions) {
  return createZzzyncHandler(
    handlerPeerId,
    mockImporter,
    allow,
    UNCAPPED,
    onReceive as unknown as OnReceive,
    options,
  );
}

describe("zzzync protocol", () => {
  it("hands off the received record", async () => {
    const [outbound, inbound] = await streamPair();

    await Promise.all([
      zzzync(
        outbound,
        handlerPeerId,
        car(helia),
        result,
        createSign(dialerKey),
      ),
      makeHandler()(inbound, connection),
    ]);

    expect(onReceive.calledOnce).toBe(true);
    const received = onReceive.firstCall.args[0];
    expect(received.name.bytes).toEqual(
      dialerKey.publicKey.toMultihash().bytes,
    );
    expect(received.record.value).toBe(result.record.value);
    expect(received.pinner.equals(dialerKey.publicKey.toCID())).toBe(true);
    // the slim ReceivedRecord carries nothing else
    expect(Object.keys(received).sort()).toEqual(["name", "pinner", "record"]);
  });

  it("passes the dialer's ipns name to allow.multihash", async () => {
    const allow: Allow = {
      multihash: sinon.stub().resolves(true),
      record: () => true,
    };
    const [outbound, inbound] = await streamPair();

    await Promise.all([
      zzzync(
        outbound,
        handlerPeerId,
        car(helia),
        result,
        createSign(dialerKey),
      ),
      makeHandler(allow)(inbound, connection),
    ]);

    const stub = allow.multihash as sinon.SinonStub;
    expect(stub.calledOnce).toBe(true);

    // the same identity allow.record is keyed by, rather than a second
    // representation the caller has to translate
    const name = stub.firstCall.args[0];
    expect(name.bytes).toEqual(
      publicKeyToIpnsMultihash(dialerKey.publicKey)?.bytes,
    );
    // and the key is still reachable from it
    expect(publicKeyFromIpnsMultihash(name)?.equals(dialerKey.publicKey)).toBe(
      true,
    );
  });

  it("aborts and does not hand off when the allow function denies", async () => {
    const allow: Allow = { multihash: () => false, record: () => true };
    const [outbound, inbound] = await streamPair();

    await expect(
      Promise.all([
        zzzync(
          outbound,
          handlerPeerId,
          car(helia),
          result,
          createSign(dialerKey),
        ),
        makeHandler(allow)(inbound, connection),
      ]),
    )
      .rejects
      .toThrow();

    expect(onReceive.called).toBe(false);
  });

  it("aborts and does not hand off when the challenge key is wrong", async () => {
    const wrongKey = (await generateKeyPair("Ed25519")) as SupportedPrivateKey;
    const [outbound, inbound] = await streamPair();

    await expect(
      Promise.all([
        zzzync(
          outbound,
          handlerPeerId,
          car(helia),
          result,
          createSign(wrongKey),
        ),
        makeHandler()(inbound, connection),
      ]),
    )
      .rejects
      .toThrow();

    expect(onReceive.called).toBe(false);
  });

  it("passes the name and record to allow.record", async () => {
    const record = sinon.stub().resolves(true);
    const allow: Allow = { multihash: () => true, record };
    const [outbound, inbound] = await streamPair();

    await Promise.all([
      zzzync(
        outbound,
        handlerPeerId,
        car(helia),
        result,
        createSign(dialerKey),
      ),
      makeHandler(allow)(inbound, connection),
    ]);

    expect(record.calledOnce).toBe(true);
    expect(record.firstCall.args[0].bytes).toEqual(
      dialerKey.publicKey.toMultihash().bytes,
    );
    expect(record.firstCall.args[1].value).toBe(result.record.value);
  });

  it("aborts and does not hand off when allow.record denies", async () => {
    const allow: Allow = { multihash: () => true, record: () => false };
    const [outbound, inbound] = await streamPair();

    await expect(
      Promise.all([
        zzzync(
          outbound,
          handlerPeerId,
          car(helia),
          result,
          createSign(dialerKey),
        ),
        makeHandler(allow)(inbound, connection),
      ]),
    )
      .rejects
      .toThrow();

    expect(onReceive.called).toBe(false);
  });

  it("aborts a stalled stream after the idle timeout", async () => {
    const [outbound, inbound] = await streamPair();

    // the dialer sends nothing and never closes its write side, so the handler
    // never sees a message and its idle timer fires
    await makeHandler(allowAll, { idleTimeoutMs: 50 })(inbound, connection);

    expect(onReceive.called).toBe(false);
    outbound.abort(new Error("test done"));
  });

  it("aborts the dialer stream when the handler never responds", async () => {
    const [outbound, inbound] = await streamPair();
    const abortSpy = sinon.spy(outbound, "abort");

    // inbound never sends its handshake nonce, so the dialer's read hits the
    // per-step deadline; zzzync should abort the stream rather than leak it
    await expect(
      zzzync(
        outbound,
        handlerPeerId,
        car(helia),
        result,
        createSign(dialerKey),
        { writeTimeoutMs: 50 },
      ),
    )
      .rejects
      .toThrow();

    expect(abortSpy.called).toBe(true);
    inbound.abort(new Error("test done"));
  });
});
