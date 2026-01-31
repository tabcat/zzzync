import { peerIdFromString } from "@libp2p/peer-id";
import { MemoryDatastore } from "datastore-core";
import { createHelia, type Pins } from "helia";
import type { Datastore } from "interface-datastore";
import { CID } from "multiformats/cid";
import { beforeAll, describe, expect, it } from "vitest";
import type { Libp2pKey } from "../src/interface.js";
import { pin, unpin } from "../src/pins.js";

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
