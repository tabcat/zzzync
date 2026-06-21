import { car } from "@helia/car";
import { unixfs } from "@helia/unixfs";
import { generateKeyPair } from "@libp2p/crypto/keys";
import type { Connection, PeerId } from "@libp2p/interface";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { streamPair } from "@libp2p/utils";
import type { IPNSPublishResult } from "@tabcat/helia-ipns";
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
import type { Allow, OnReceive } from "../src/handler.ts";

// shared fixtures
let helia: Helia;
let dialerKey: SupportedPrivateKey;
let handlerPeerId: PeerId;
let contentCid: CID;
let result: IPNSPublishResult;

beforeAll(async () => {
  helia = await createHelia({ start: false });
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

function makeHandler(options?: { allow?: Allow; }) {
  return createZzzyncHandler(
    handlerPeerId,
    mockImporter,
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

  it("passes the dialer public key to allow.multihash", async () => {
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
      makeHandler({ allow })(inbound, connection),
    ]);

    const stub = allow.multihash as sinon.SinonStub;
    expect(stub.calledOnce).toBe(true);
    expect(stub.firstCall.args[0].equals(dialerKey.publicKey)).toBe(true);
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
        makeHandler({ allow })(inbound, connection),
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
      makeHandler({ allow })(inbound, connection),
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
        makeHandler({ allow })(inbound, connection),
      ]),
    )
      .rejects
      .toThrow();

    expect(onReceive.called).toBe(false);
  });
});
