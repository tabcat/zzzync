import { CarWriter } from "@ipld/car";
import * as dagPb from "@ipld/dag-pb";
import type { Stream } from "@libp2p/interface";
import { defaultLogger } from "@libp2p/logger";
import { byteStream, streamPair } from "@libp2p/utils";
import * as Block from "multiformats/block";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import * as varint from "uint8-varint";
import { Uint8ArrayList } from "uint8arraylist";
import { concat } from "uint8arrays";
import { describe, expect, it } from "vitest";
import { readCarFile } from "../src/handler.ts";
import type { CarLimits } from "../src/handler.ts";

// tests exercise one cap at a time, so the rest sit wide open. @ipld/car
// rejects Infinity for its two, so those use its own defaults instead.
const UNCAPPED: CarLimits = {
  maxByteLength: Infinity,
  maxBlockCount: Infinity,
  maxCarSectionSize: 8 * 1024 * 1024,
  maxCarHeaderSize: 32 * 1024 * 1024,
};
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
  limits: Partial<CarLimits> = {},
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
      { ...UNCAPPED, ...limits },
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

  it("stops feeding the decoder once raw bytes exceed maxByteLength", async () => {
    // a block under the CAR section cap but over the configured CAR cap. The point of
    // the HIGH fix: the budget must cut the source off, not let @ipld/car buffer
    // the whole declared block before the post-decode caps ever run.
    const big = await rawBlock(new Uint8Array(1024 * 1024));
    const root = await dagPbBlock([{ name: "big", cid: big.cid }]);
    const carBytes = await buildCar([root.cid], [root, big]);

    // feed the CAR in small chunks through a counting source so we can see how
    // many raw bytes get pulled before readCarFile gives up
    const chunkSize = 16 * 1024;
    let off = 0;
    let pulled = 0;
    const bs = {
      read: async () => {
        if (off >= carBytes.length) return null;
        const chunk = carBytes.subarray(off, off + chunkSize);
        off += chunk.length;
        pulled += chunk.length;
        // a real Uint8ArrayList, as byteStream.read returns: readCarFile
        // copies it, which a bare iterable cannot model
        return new Uint8ArrayList(chunk);
      },
    } as unknown as Parameters<typeof readCarFile>[0];

    await expect(
      readCarFile(bs, drain, root.cid as UnixFsCID, log, {
        ...UNCAPPED,
        maxByteLength: 64 * 1024,
      }),
    )
      .rejects
      .toThrow("max byte length");

    // with the budget: ~cap + one chunk; without it: the whole ~1MiB CAR
    expect(pulled).toBeLessThan(128 * 1024);
  });

  it("rejects a block whose bytes do not match its CID", async () => {
    // @ipld/car only parses CAR structure, it does not verify blocks, so this is
    // purely zzzync's create() hash check (keep it create(), not createUnsafe())
    const child = await rawBlock(new Uint8Array([1, 2, 3]));
    const root = await dagPbBlock([{ name: "child", cid: child.cid }]);
    // deliver the child's CID with tampered bytes that do not hash to it
    const car = await buildCar([root.cid], [root, {
      cid: child.cid,
      bytes: new Uint8Array([9, 9, 9]),
    }]);
    await expect(runReadCar(car, root.cid)).rejects.toThrow(
      "hash does not match",
    );
  });

  // --- size limits passed through to @ipld/car ---------------------------------

  // The framed header of a real CAR: its varint length prefix plus that many bytes.
  function headerOf(car: Uint8Array): Uint8Array {
    const length = varint.decode(car);
    return car.subarray(0, varint.encodingLength(length) + length);
  }

  // A source that reports how many raw bytes readCarFile actually pulled, so a
  // test can tell "rejected the declared length" from "buffered it first".
  function countingSource(bytes: Uint8Array) {
    let off = 0;
    const state = { pulled: 0 };
    const bs = {
      read: async () => {
        if (off >= bytes.length) return null;
        const chunk = bytes.subarray(off, off + 256);
        off += chunk.length;
        state.pulled += chunk.length;
        // a real Uint8ArrayList, as byteStream.read returns: readCarFile
        // copies it, which a bare iterable cannot model
        return new Uint8ArrayList(chunk);
      },
    } as unknown as Parameters<typeof readCarFile>[0];
    return { bs, state };
  }

  it("rejects an over-cap section from its declared length, before allocating it", async () => {
    const child = await rawBlock(new Uint8Array([1, 2, 3]));
    const root = await dagPbBlock([{ name: "child", cid: child.cid }]);
    const car = await buildCar([root.cid], [root, child]);

    // a section claiming 4MiB, followed by almost none of it. 4MiB is under
    // @ipld/car's own 8MiB default, so only the configured cap can reject this,
    // and rejecting on the varint alone is the point: the bytes are never sent.
    // padded well past the 1KiB assertion so the byte counter actually
    // discriminates: buffering the declared body would blow through it
    const forged = concat([
      headerOf(car),
      varint.encode(4 * 1024 * 1024),
      new Uint8Array(64 * 1024),
    ]);
    const { bs, state } = countingSource(forged);

    await expect(
      readCarFile(bs, drain, root.cid as UnixFsCID, log, {
        ...UNCAPPED,
        maxCarSectionSize: 2 * 1024 * 1024,
      }),
    )
      .rejects
      .toThrow(/maxAllowedSectionSize/);

    expect(state.pulled).toBeLessThan(1024);
  });

  it("rejects an over-cap header from its declared length, before allocating it", async () => {
    const child = await rawBlock(new Uint8Array([1, 2, 3]));
    const root = await dagPbBlock([{ name: "child", cid: child.cid }]);

    // 2MiB is under @ipld/car's own 32MiB default, so only the configured cap
    // can reject it, and it must do so from the varint alone
    const forged = concat([
      varint.encode(2 * 1024 * 1024),
      new Uint8Array(64 * 1024),
    ]);
    const { bs, state } = countingSource(forged);

    await expect(
      readCarFile(bs, drain, root.cid as UnixFsCID, log, {
        ...UNCAPPED,
        maxCarHeaderSize: 1024,
      }),
    )
      .rejects
      .toThrow(/maxAllowedHeaderSize/);

    expect(state.pulled).toBeLessThan(1024);
  });

  it("applies a configured maxCarSectionSize to a real over-cap block", async () => {
    const big = await rawBlock(new Uint8Array(64 * 1024));
    const root = await dagPbBlock([{ name: "big", cid: big.cid }]);
    const car = await buildCar([root.cid], [root, big]);

    await expect(runReadCar(car, root.cid, { maxCarSectionSize: 1024 })).rejects
      .toThrow(/maxAllowedSectionSize/);
  });

  it("applies a configured maxCarHeaderSize to a real header", async () => {
    const child = await rawBlock(new Uint8Array([1, 2, 3]));
    const root = await dagPbBlock([{ name: "child", cid: child.cid }]);
    const car = await buildCar([root.cid], [root, child]);

    // a real 1-root header is ~58 bytes, so 8 rejects it without forging anything
    await expect(runReadCar(car, root.cid, { maxCarHeaderSize: 8 })).rejects
      .toThrow(/maxAllowedHeaderSize/);
  });

  it("still applies @ipld/car's own section cap when unset", async () => {
    const child = await rawBlock(new Uint8Array([1, 2, 3]));
    const root = await dagPbBlock([{ name: "child", cid: child.cid }]);
    const car = await buildCar([root.cid], [root, child]);

    // unset means zzzync caps nothing, but @ipld/car still defaults to 8MiB per
    // section, which is the guarantee that replaced the old hard MAX_BLOCK_BYTES
    const forged = concat([
      headerOf(car),
      varint.encode(9 * 1024 * 1024),
      new Uint8Array(1024),
    ]);
    const { bs } = countingSource(forged);

    await expect(readCarFile(bs, drain, root.cid as UnixFsCID, log, UNCAPPED))
      .rejects
      .toThrow(/maxAllowedSectionSize/);
  });

  it("does not cap total bytes when maxByteLength is unset", async () => {
    // six 1MiB blocks is over the 5MiB total that used to be the default, so
    // this fails the moment anyone reinstates one
    const blocks = await Promise.all(Array.from({ length: 6 }, (_, i) => {
      // distinct bytes per block, or they share a CID and the dedup guard
      // rejects the second as unreferenced
      const bytes = new Uint8Array(1024 * 1024);
      bytes[0] = i;
      return rawBlock(bytes);
    }));
    const root = await dagPbBlock(
      blocks.map((b, i) => ({ name: `b${i}`, cid: b.cid })),
    );
    const car = await buildCar([root.cid], [root, ...blocks]);
    await expect(runReadCar(car, root.cid)).resolves.toBeUndefined();
  });

  it("does not cap block count when maxBlockCount is unset", async () => {
    // past the 10_000 that used to be the default
    const blocks = await Promise.all(
      Array.from({ length: 10_051 }, (_, i) =>
        rawBlock(
          new Uint8Array([i & 0xff, (i >> 8) & 0xff, (i >> 16) & 0xff]),
        )),
    );
    const root = await dagPbBlock(
      blocks.map((b, i) => ({ name: `b${i}`, cid: b.cid })),
    );
    const car = await buildCar([root.cid], [root, ...blocks]);
    await expect(runReadCar(car, root.cid)).resolves.toBeUndefined();
  });
});
