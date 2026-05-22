import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey, peerIdFromString } from "@libp2p/peer-id";
import { MemoryDatastore } from "datastore-core";
import { createHelia, type Pins } from "helia";
import type { Datastore } from "interface-datastore";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { beforeAll, describe, expect, it } from "vitest";
import type { Libp2pKey } from "../src/interface.js";
import { pin, unpin } from "../src/pins.js";

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Minimal stateful stand-in for helia's Pins, faithful to the parts pin/unpin
 * use: add throws AlreadyPinnedError when the cid is already pinned, get
 * returns a snapshot (copy) of the metadata or throws NotFoundError, and
 * setMetadata/rm mutate the store.
 *
 * `get` yields to the event loop before reading so that concurrent
 * read-modify-write callers interleave deterministically — real helia hangs
 * under this contention rather than failing cleanly, so a controllable double
 * is the only way to assert the race instead of timing out.
 */
class FakePins {
  private store = new Map<string, Record<string, number>>();

  async *add(
    cid: CID,
    options?: { metadata?: Record<string, number>; },
  ): AsyncGenerator<CID> {
    const key = cid.toString();
    if (this.store.has(key)) {
      throw Object.assign(new Error("Already pinned"), {
        name: "AlreadyPinnedError",
      });
    }
    this.store.set(key, { ...(options?.metadata ?? {}) });
    yield cid;
  }

  async get(
    cid: CID,
  ): Promise<{ cid: CID; metadata: Record<string, number>; }> {
    // snapshot at call time, then yield to the event loop: models a read that
    // is not atomic with the caller's later setMetadata, so a concurrent
    // read-modify-write can interleave in the gap
    const snapshot = this.store.get(cid.toString());
    await delay(10);
    if (snapshot == null) {
      throw Object.assign(new Error("Not Found"), { name: "NotFoundError" });
    }
    return { cid, metadata: { ...snapshot } };
  }

  async setMetadata(cid: CID, metadata: Record<string, number>): Promise<void> {
    this.store.set(cid.toString(), { ...metadata });
  }

  async *rm(cid: CID): AsyncGenerator<CID> {
    this.store.delete(cid.toString());
    yield cid;
  }

  async isPinned(cid: CID): Promise<boolean> {
    return this.store.has(cid.toString());
  }
}

describe("Pins", () => {
  let pins: Pins;
  let datastore: Datastore;
  let libp2pKey1: Libp2pKey;
  let libp2pKey2: Libp2pKey;
  let cid: CID;

  beforeAll(async () => {
    datastore = new MemoryDatastore();
    const helia = await createHelia({ datastore, start: false });
    pins = helia.pins;
    const peerId1 = peerIdFromString(
      "12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8",
    );
    libp2pKey1 = peerId1.toCID() as Libp2pKey;
    const peerId2 = peerIdFromString(
      "12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc9",
    );
    libp2pKey2 = peerId2.toCID() as Libp2pKey;
    cid = CID.parse(
      "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
    );
  });

  describe("pin", () => {
    it("pins the cid and adds the pinner with metadata", async () => {
      await pin(pins, libp2pKey1, cid);

      const { metadata } = await pins.get(cid);
      expect(Object.keys(metadata).length).to.equal(1);
      expect(metadata[libp2pKey1.toString()]).to.be.lessThan(Date.now());
    });

    it("adds the pinner to metadata", async () => {
      await pin(pins, libp2pKey2, cid);

      const { metadata } = await pins.get(cid);
      expect(Object.keys(metadata).length).to.equal(2);
      expect(metadata[libp2pKey1.toString()]).to.be.lessThan(Date.now());
      expect(metadata[libp2pKey2.toString()]).to.be.lessThanOrEqual(Date.now());
    });
  });

  describe("unpin", () => {
    it("unpins the cid and removes the pinner from metadata", async () => {
      await unpin(pins, libp2pKey2, cid);

      const { metadata } = await pins.get(cid);
      expect(Object.keys(metadata).length).to.equal(1);
      expect(metadata[libp2pKey1.toString()]).to.be.lessThan(Date.now());
    });

    it("removes the pinner from metadata", async () => {
      await unpin(pins, libp2pKey1, cid);

      await expect(pins.get(cid)).rejects.toThrow("Not Found");
    });
  });
});

describe("pin/unpin concurrency", () => {
  const makePinner = async (): Promise<Libp2pKey> =>
    peerIdFromPrivateKey(await generateKeyPair("Ed25519")).toCID() as Libp2pKey;

  const freshCid = async (seed: string): Promise<CID> =>
    CID.createV1(0x55, await sha256.digest(new TextEncoder().encode(seed)));

  it("keeps every pinner when the same cid is pinned concurrently", async () => {
    const pins = new FakePins() as unknown as Pins;
    const cid = await freshCid("concurrent-pins");
    const [seed, p1, p2] = await Promise.all([
      makePinner(),
      makePinner(),
      makePinner(),
    ]);
    // pre-pin so both concurrent calls take the read-modify-write path
    await pin(pins, seed, cid);

    await Promise.all([pin(pins, p1, cid), pin(pins, p2, cid)]);

    const { metadata } = await pins.get(cid);
    expect(Object.keys(metadata).sort()).toEqual(
      [seed, p1, p2].map((pinner) => pinner.toString()).sort(),
    );
  });

  it("does not clobber a concurrent pin when another pinner unpins", async () => {
    const pins = new FakePins() as unknown as Pins;
    const cid = await freshCid("concurrent-pin-unpin");
    const [a, b, c] = await Promise.all([
      makePinner(),
      makePinner(),
      makePinner(),
    ]);

    await pin(pins, a, cid);
    await pin(pins, b, cid);

    // remove a and add c at the same time; both touch the same metadata
    await Promise.all([unpin(pins, a, cid), pin(pins, c, cid)]);

    const { metadata } = await pins.get(cid);
    expect(Object.keys(metadata).sort()).toEqual(
      [b, c].map((pinner) => pinner.toString()).sort(),
    );
  });
});
