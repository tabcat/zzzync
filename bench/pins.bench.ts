import { peerIdFromString } from "@libp2p/peer-id";
import { LevelDatastore } from "datastore-level";
import { createHelia, type Pins } from "helia";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { CID } from "multiformats/cid";
import { afterAll, beforeAll, bench, describe } from "vitest";
import type { Libp2pKey } from "../src/interface.js";
import { pin, unpin } from "../src/pins.js";

const BENCH_DIR = join(tmpdir(), `zzzync-pins-bench-${Date.now()}`);

let pins: Pins;
let pinner1: Libp2pKey;
let pinner2: Libp2pKey;
let cid: CID;

beforeAll(async () => {
  const datastore = new LevelDatastore(BENCH_DIR);
  await datastore.open();
  const helia = await createHelia({ datastore, start: false });
  pins = helia.pins;

  pinner1 = peerIdFromString(
    "12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8",
  ).toCID() as Libp2pKey;
  pinner2 = peerIdFromString(
    "12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc9",
  ).toCID() as Libp2pKey;
  cid = CID.parse("bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku");
});

afterAll(async () => {
  await rm(BENCH_DIR, { recursive: true, force: true });
});

describe("pin", () => {
  bench(
    "new entry",
    async () => {
      await pin(pins, pinner1, cid);
    },
    {
      afterEach: async () => {
        await unpin(pins, pinner1, cid);
      },
    },
  );

  bench(
    "add pinner to existing entry",
    async () => {
      await pin(pins, pinner2, cid);
    },
    {
      beforeEach: async () => {
        await pin(pins, pinner1, cid);
      },
      afterEach: async () => {
        await unpin(pins, pinner1, cid);
        await unpin(pins, pinner2, cid);
      },
    },
  );
});

describe("unpin", () => {
  bench(
    "remove last pinner (deletes entry)",
    async () => {
      await unpin(pins, pinner1, cid);
    },
    {
      beforeEach: async () => {
        await pin(pins, pinner1, cid);
      },
    },
  );

  bench(
    "remove one of many pinners (updates metadata)",
    async () => {
      await unpin(pins, pinner2, cid);
    },
    {
      beforeEach: async () => {
        await pin(pins, pinner1, cid);
        await pin(pins, pinner2, cid);
      },
      afterEach: async () => {
        await unpin(pins, pinner1, cid);
      },
    },
  );
});
