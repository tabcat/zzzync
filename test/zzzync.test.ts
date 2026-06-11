import { car } from "@helia/car";
import type { Car } from "@helia/car";
import { unixfs } from "@helia/unixfs";
import { generateKeyPair } from "@libp2p/crypto/keys";
import type { Connection, PeerId } from "@libp2p/interface";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { streamPair } from "@libp2p/utils";
import type { IPNS, IPNSPublishResult } from "@tabcat/helia-ipns";
import { createHelia } from "helia";
import type { Helia } from "helia";
import { createIPNSRecord } from "ipns";
import type { CID } from "multiformats/cid";
import sinon from "sinon";
import { stubInterface } from "sinon-ts";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { createSign } from "../src/challenge.js";
import type { SupportedPrivateKey } from "../src/challenge.js";
import { zzzync } from "../src/dialer.js";
import { createZzzyncHandler } from "../src/handler.js";
import type { Allow, OnReceive } from "../src/handler.js";

// ─── shared test fixtures ────────────────────────────────────────────────────

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
  const handlerKey = await generateKeyPair("Ed25519");
  handlerPeerId = peerIdFromPrivateKey(handlerKey);

  const record = await createIPNSRecord(dialerKey, contentCid, 0, 3_600_000);
  result = { record, publicKey: dialerKey.publicKey };
});

afterAll(async () => {
  await helia.stop();
});

// ─── per-test stubs ──────────────────────────────────────────────────────────

let mockIpns: ReturnType<typeof stubInterface<IPNS>>;
let mockImporter: Pick<Car, "import">;
let onReceive: sinon.SinonStub;
let connection: Connection;

beforeEach(() => {
  mockIpns = stubInterface<IPNS>();
  // no local record exists
  mockIpns.resolve.rejects(
    Object.assign(new Error("not found"), { name: "RecordNotFoundError" }),
  );
  // the handler's offline local write
  mockIpns.republish.resolves({} as any);

  // the handoff: ice-queen persists + pins + publishes; here just a spy
  onReceive = sinon.stub().resolves();

  // consume blocks so the CAR generator runs
  mockImporter = {
    import: async ({ blocks }: any) => {
      for await (const _ of blocks()) {}
    },
  } as any;

  connection = { remotePeer: peerIdFromPrivateKey(dialerKey) } as any;
});

afterEach(() => {
  sinon.restore();
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeHandler(options?: { allow?: Allow; }) {
  return createZzzyncHandler(
    handlerPeerId,
    mockIpns,
    mockImporter,
    onReceive as unknown as OnReceive,
    options,
  );
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("zzzync protocol", () => {
  it("writes the record offline then hands off the received record", async () => {
    const [outbound, inbound] = await streamPair();
    const handler = makeHandler();
    const exporter = car(helia);

    await Promise.all([
      zzzync(outbound, handlerPeerId, exporter, result, createSign(dialerKey)),
      handler(inbound, connection),
    ]);

    // local write happened offline (no DHT) before the handoff
    expect(mockIpns.republish.calledOnce).toBe(true);
    expect(mockIpns.republish.firstCall.args[1]?.offline).toBe(true);

    // handed off exactly once with the received record
    expect(onReceive.calledOnce).toBe(true);
    const received = onReceive.firstCall.args[0];
    expect(received.name.bytes).toEqual(
      dialerKey.publicKey.toMultihash().bytes,
    );
    expect(received.value.equals(contentCid)).toBe(true);
    expect(received.pinner.equals(dialerKey.publicKey.toCID())).toBe(true);
    expect(received.valueChanged).toBe(true);
    expect(received.previousValue).toBe(null);
  });

  it("passes the dialer public key to the allow function", async () => {
    const allow: Allow = { allow: sinon.stub().resolves(true) };
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

    const stub = allow.allow as sinon.SinonStub;
    expect(stub.calledOnce).toBe(true);
    expect(stub.firstCall.args[0].equals(dialerKey.publicKey)).toBe(true);
  });

  it("aborts and does not hand off when the allow function denies", async () => {
    const allow: Allow = { allow: () => false };
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

  it("does not write or hand off when the local record is up to date", async () => {
    // resolve returns the same record -> localRecordEqual
    mockIpns.resolve.resolves({ record: result.record } as any);

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

    expect(mockIpns.republish.called).toBe(false);
    expect(onReceive.called).toBe(false);
  });
});
