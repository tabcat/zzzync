import { CarWriter } from "@ipld/car";
import * as dagPb from "@ipld/dag-pb";
import type { Stream } from "@libp2p/interface";
import { defaultLogger } from "@libp2p/logger";
import { byteStream, streamPair } from "@libp2p/utils";
import * as Block from "multiformats/block";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { concat } from "uint8arrays";
import { describe, expect, it } from "vitest";
import { readCarFile } from "../src/handler.ts";
import type { UnixFsCID } from "../src/interface.ts";

const log = defaultLogger().forComponent("test");

// importer that just drains the verified block stream
const drain: {
  import: (arg: { blocks: () => AsyncIterable<unknown>; }) => Promise<void>;
} = {
  import: async ({ blocks }) => {
    for await (const _ of blocks()) { /* drain */ }
  },
};

async function rawBlock(data: Uint8Array) {
  return Block.encode({ value: data, codec: raw, hasher: sha256 });
}

async function dagPbBlock(links: Array<{ name: string; cid: CID; }>) {
  const node = dagPb.createNode(
    new Uint8Array(0),
    links.map((l) => dagPb.createLink(l.name, 0, l.cid)),
  );
  return Block.encode({ value: node, codec: dagPb, hasher: sha256 });
}

async function buildCar(
  roots: CID[],
  blocks: Array<{ cid: CID; bytes: Uint8Array; }>,
): Promise<Uint8Array> {
  const { writer, out } = CarWriter.create(roots);
  const chunks: Uint8Array[] = [];
  const collecting = (async () => {
    for await (const chunk of out) chunks.push(chunk);
  })();
  for (const block of blocks) {
    await writer.put(block);
  }
  await writer.close();
  await collecting;
  return concat(chunks);
}

async function runReadCar(
  carBytes: Uint8Array,
  expectedRoot: CID,
  options: { maxByteLength?: number; maxBlockCount?: number; } = {},
): Promise<void> {
  const [outbound, inbound] = await streamPair();
  const writing = (async () => {
    try {
      const obs = byteStream(outbound as Stream);
      await obs.write(carBytes);
      await (outbound as Stream).close();
    } catch { /* the stream may abort when readCarFile rejects */ }
  })();
  try {
    await readCarFile(
      byteStream(inbound as Stream),
      drain,
      expectedRoot as UnixFsCID,
      log,
      options,
    );
  } finally {
    await writing;
  }
}

describe("readCarFile", () => {
  it("accepts a complete DAG", async () => {
    const child = await rawBlock(new Uint8Array([1, 2, 3]));
    const root = await dagPbBlock([{ name: "child", cid: child.cid }]);
    const car = await buildCar([root.cid], [root, child]);
    await expect(runReadCar(car, root.cid)).resolves.toBeUndefined();
  });

  it("rejects an incomplete DAG (referenced child not delivered)", async () => {
    const child = await rawBlock(new Uint8Array([1, 2, 3]));
    const root = await dagPbBlock([{ name: "child", cid: child.cid }]);
    const car = await buildCar([root.cid], [root]); // child omitted
    await expect(runReadCar(car, root.cid)).rejects.toThrow("incomplete");
  });

  it("accepts a diamond with a shared child delivered before its 2nd parent", async () => {
    const x = await rawBlock(new Uint8Array([9]));
    // distinct link names so a and b are different blocks both linking x
    const a = await dagPbBlock([{ name: "xa", cid: x.cid }]);
    const b = await dagPbBlock([{ name: "xb", cid: x.cid }]);
    const root = await dagPbBlock([{ name: "a", cid: a.cid }, {
      name: "b",
      cid: b.cid,
    }]);
    const car = await buildCar([root.cid], [root, a, x, b]);
    await expect(runReadCar(car, root.cid)).resolves.toBeUndefined();
  });

  it("rejects a duplicate block", async () => {
    const child = await rawBlock(new Uint8Array([1]));
    const root = await dagPbBlock([{ name: "child", cid: child.cid }]);
    const car = await buildCar([root.cid], [root, child, child]);
    await expect(runReadCar(car, root.cid)).rejects.toThrow();
  });

  it("rejects an unreferenced block", async () => {
    const child = await rawBlock(new Uint8Array([1]));
    const stray = await rawBlock(new Uint8Array([2]));
    const root = await dagPbBlock([{ name: "child", cid: child.cid }]);
    const car = await buildCar([root.cid], [root, child, stray]);
    await expect(runReadCar(car, root.cid)).rejects.toThrow("referenced");
  });

  it("rejects a CAR whose root does not match the expected root", async () => {
    const child = await rawBlock(new Uint8Array([1]));
    const root = await dagPbBlock([{ name: "child", cid: child.cid }]);
    const other = await rawBlock(new Uint8Array([42]));
    const car = await buildCar([root.cid], [root, child]);
    await expect(runReadCar(car, other.cid)).rejects.toThrow(
      "ERR_UNEXPECTED_ROOT",
    );
  });

  it("rejects a codec downgrade (dag-pb link delivered as a raw block)", async () => {
    const rawChild = await rawBlock(new Uint8Array([7, 7, 7]));
    // a dag-pb CID over the same multihash as the raw child
    const dagPbCid = CID.create(1, 0x70, rawChild.cid.multihash);
    const root = await dagPbBlock([{ name: "child", cid: dagPbCid }]);
    // deliver the raw block; its CID codec differs from the dag-pb link
    const car = await buildCar([root.cid], [root, rawChild]);
    await expect(runReadCar(car, root.cid)).rejects.toThrow();
  });

  it("rejects a CAR over the max byte length", async () => {
    const child = await rawBlock(new Uint8Array([1, 2, 3]));
    const root = await dagPbBlock([{ name: "child", cid: child.cid }]);
    const car = await buildCar([root.cid], [root, child]);
    await expect(runReadCar(car, root.cid, { maxByteLength: 1 })).rejects
      .toThrow("max byte length");
  });

  it("rejects a CAR over the max block count", async () => {
    const child = await rawBlock(new Uint8Array([1, 2, 3]));
    const root = await dagPbBlock([{ name: "child", cid: child.cid }]);
    const car = await buildCar([root.cid], [root, child]);
    await expect(runReadCar(car, root.cid, { maxBlockCount: 1 })).rejects
      .toThrow("max block count");
  });
});
