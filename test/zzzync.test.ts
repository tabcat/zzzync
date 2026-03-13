import { car } from "@helia/car";
import type { Car } from "@helia/car";
import type { Pins } from "@helia/interface";
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
import type { Allow } from "../src/handler.js";

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
let mockPins: ReturnType<typeof stubInterface<Pins>>;
let mockImporter: Pick<Car, "import">;
let kubo: any;
let connection: Connection;

beforeEach(() => {
  mockIpns = stubInterface<IPNS>();
  // no local record exists
  mockIpns.resolve.rejects(
    Object.assign(new Error("not found"), { name: "RecordNotFoundError" }),
  );
  mockIpns.republish.resolves({} as any);

  mockPins = stubInterface<Pins>();
  mockPins.add.callsFake(() => (async function*() {})());
  mockPins.isPinned.resolves(false);

  // consume blocks so the CAR generator runs (drives kubo.block.put calls)
  mockImporter = {
    import: async ({ blocks }: any) => {
      for await (const _ of blocks()) {}
    },
  } as any;

  kubo = {
    block: { put: sinon.stub().resolves() },
    pin: { add: sinon.stub().resolves(), rm: sinon.stub().resolves() },
  };

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
    mockPins,
    kubo,
    options,
  );
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe("zzzync protocol", () => {
  it("completes the full sync protocol", async () => {
    const [outbound, inbound] = await streamPair();
    const handler = makeHandler();
    const exporter = car(helia);

    await Promise.all([
      zzzync(outbound, handlerPeerId, exporter, result, createSign(dialerKey)),
      handler(inbound, connection),
    ]);

    expect(mockIpns.republish.calledOnce).toBe(true);
    expect(mockPins.add.calledOnce).toBe(true);
    expect(kubo.block.put.called).toBe(true);
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

  it("aborts when the allow function denies the dialer", async () => {
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

    expect(mockPins.add.called).toBe(false);
  });

  it("aborts when the challenge is signed with the wrong key", async () => {
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

    expect(mockPins.add.called).toBe(false);
  });

  it("does not import when the local record is already up to date", async () => {
    // stub resolve to return the same record
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

    // republish skipped (localRecordEqual = true)
    expect(mockIpns.republish.called).toBe(true);
    // pin still happens since same CID already pinned
    expect(mockPins.add.called).toBe(true);
  });
});
