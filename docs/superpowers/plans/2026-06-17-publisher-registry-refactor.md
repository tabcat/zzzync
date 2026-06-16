# Publisher / republishing-registry refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make ice-queen's durable registry the source of truth for the names it republishes, shrink the zzzync handler to receive-validate-handoff, add an `allowRecord` downgrade guard, and give pinning the same durable, retried, failure-aware treatment as republishing.

**Architecture:** The zzzync handler drops its `ipns` dependency and `selectRemoteRecord`; it authenticates, validates the record, calls a new `allowRecord` hook, imports the CAR, and hands `{ name, record, pinner }` to `onReceive`. ice-queen owns a cbor-encoded registry under `/ice-queen/republishing/`, keyed by name, that stores the desired record plus the applied `pinnedValue`. The publisher reconciles applied state toward the record under a per-name keyed mutex (reused from zzzync): pin first (durable, retried, failure-aware), then publish. The daemon gates GC on zero pin failures.

**Tech Stack:** TypeScript (zzzync builds with `tsc` to `dist`; ice-queen runs `.ts` source directly via Node 24 type-stripping), libp2p / Helia / `@tabcat/helia-ipns`, `ipns`, `cborg`, `interface-datastore` + `datastore-core` (tests), vitest, sinon / sinon-ts.

---

## Cross-repo ordering and the linked dist

ice-queen consumes zzzync through `@tabcat/zzzync: link:../zzzync`, and zzzync's `package.json` `exports` point at `./dist/src/*.js`. **ice-queen sees zzzync's built `dist`, not its source.** So after any zzzync source change, you MUST `pnpm -C ../zzzync build` before ice-queen can typecheck against it.

Consequence for sequencing: Task 2 slims `ReceivedRecord` and drops the handler's `ipns` arg. The moment that builds, ice-queen's current `publisher.ts` / `server.ts` stop typechecking, and they stay red until Tasks 4-5 land. That is expected. Verify zzzync in isolation after Tasks 1-2 (its own tests + build are green); do not run ice-queen's typecheck until Task 5.

Absolute paths used below:
- zzzync: `/home/tabcat/github.com/tabcat/zzzync`
- ice-queen: `/home/tabcat/github.com/tabcat/ice-queen`

Commands use `-C <dir>` so no `cd` is needed.

## File Structure

**zzzync (modify):**
- `src/index.ts` - add `createKeyedMutex` + `KeyedMutex` exports.
- `package.json` - add the `./mutex` export subpath.
- `src/handler.ts` - drop `ipns` param, `selectRemoteRecord`, the offline write; add `allowRecord` to `CreateHandlerOptions`; slim `ReceivedRecord`; reorder the per-stream flow.
- `src/interface.ts` - remove the now-unused `HandlerIpns` (and its `IPNS` import).
- `test/mutex.test.ts` - add one test that the index re-exports `createKeyedMutex`.
- `test/zzzync.test.ts` - rewrite handler tests for the new signature + `allowRecord`.

**ice-queen (create):**
- `src/republishing-store.ts` - cbor registry + smart-constructors (`toIpnsMultihash`, `toLibp2pKey`).
- `test/republishing-store.test.ts` - round-trip + constructor validation.
- `test/publisher.test.ts` - publisher behavior with fakes.

**ice-queen (modify):**
- `package.json` - add `cborg` (dep) and `datastore-core` (devDep).
- `src/publisher.ts` - full rewrite (registry source of truth, keyed mutex, pin-then-publish reconcile, status, failure handling).
- `src/server.ts` - drop the `ipns` arg to the handler; pass `allowRecord: publisher.allowRecord`.
- `src/daemon.ts` - gate GC on `resumePins()`'s failure count.

**ice-queen (delete):**
- `src/pending-store.ts` - replaced by `republishing-store.ts` (delete in Task 4, once `publisher.ts` no longer imports it).

---

## Task 1: zzzync - export `createKeyedMutex` (+ `./mutex` subpath)

**Files:**
- Modify: `/home/tabcat/github.com/tabcat/zzzync/src/index.ts`
- Modify: `/home/tabcat/github.com/tabcat/zzzync/package.json`
- Test: `/home/tabcat/github.com/tabcat/zzzync/test/mutex.test.ts`

The behavior of `createKeyedMutex` is already covered by `test/mutex.test.ts`. This task only makes it part of the public API so ice-queen can import it.

- [ ] **Step 1: Add a failing test that the package index re-exports it**

Append to `/home/tabcat/github.com/tabcat/zzzync/test/mutex.test.ts` (inside the existing file, after the existing `describe`):

```ts
import { createKeyedMutex as createKeyedMutexFromIndex } from "../src/index.js";

describe("createKeyedMutex (public export)", () => {
  it("is re-exported from the package index", () => {
    expect(typeof createKeyedMutexFromIndex).toBe("function");
    const mutex = createKeyedMutexFromIndex();
    expect(mutex.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test, watch it fail**

Run: `pnpm -C /home/tabcat/github.com/tabcat/zzzync exec vitest run test/mutex.test.ts`
Expected: FAIL - `createKeyedMutex` is not exported by `../src/index.js` (import resolves to `undefined`, so `typeof` is `"undefined"`).

- [ ] **Step 3: Add the exports to the index**

In `/home/tabcat/github.com/tabcat/zzzync/src/index.ts`, add after the existing `pins` export line:

```ts
export { createKeyedMutex } from "./mutex.js";
export type { KeyedMutex } from "./mutex.js";
```

- [ ] **Step 4: Run the test, watch it pass**

Run: `pnpm -C /home/tabcat/github.com/tabcat/zzzync exec vitest run test/mutex.test.ts`
Expected: PASS (all `createKeyedMutex` tests, including the new export test).

- [ ] **Step 5: Add the `./mutex` subpath to `package.json` exports**

In `/home/tabcat/github.com/tabcat/zzzync/package.json`, add a new entry inside `"exports"` (next to `"./pins"`):

```json
    "./mutex": {
      "types": "./dist/src/mutex.d.ts",
      "import": "./dist/src/mutex.js"
    },
```

- [ ] **Step 6: Build so `dist` + the subpath resolve, then run the full suite**

Run: `pnpm -C /home/tabcat/github.com/tabcat/zzzync build`
Expected: clean `tsc`, and `dist/src/mutex.js` + `dist/src/mutex.d.ts` exist.
Run: `pnpm -C /home/tabcat/github.com/tabcat/zzzync test`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git -C /home/tabcat/github.com/tabcat/zzzync add src/index.ts package.json test/mutex.test.ts
git -C /home/tabcat/github.com/tabcat/zzzync commit -m "feat: export createKeyedMutex and add ./mutex subpath"
```

---

## Task 2: zzzync - handler refactor

**Files:**
- Test: `/home/tabcat/github.com/tabcat/zzzync/test/zzzync.test.ts` (rewrite handler tests)
- Modify: `/home/tabcat/github.com/tabcat/zzzync/src/handler.ts`
- Modify: `/home/tabcat/github.com/tabcat/zzzync/src/interface.ts`

The handler drops the `ipns` parameter, `selectRemoteRecord`, and the offline local write; it adds an `allowRecord` option (the authoritative downgrade guard) and slims `ReceivedRecord` to `{ name, record, pinner }`.

- [ ] **Step 1: Rewrite the handler tests for the new behavior**

Replace the entire contents of `/home/tabcat/github.com/tabcat/zzzync/test/zzzync.test.ts` with:

```ts
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
import { createSign } from "../src/challenge.js";
import type { SupportedPrivateKey } from "../src/challenge.js";
import { zzzync } from "../src/dialer.js";
import { createZzzyncHandler } from "../src/handler.js";
import type {
  Allow,
  CreateHandlerOptions,
  OnReceive,
} from "../src/handler.js";

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
let mockImporter: { import: (arg: { blocks: () => AsyncIterable<unknown>; }) => Promise<void>; };
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
  connection = { remotePeer: peerIdFromPrivateKey(dialerKey) } as unknown as Connection;
});

afterEach(() => {
  sinon.restore();
});

function makeHandler(
  options?: {
    allow?: Allow;
    allowRecord?: CreateHandlerOptions["allowRecord"];
  },
) {
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
      zzzync(outbound, handlerPeerId, car(helia), result, createSign(dialerKey)),
      makeHandler()(inbound, connection),
    ]);

    expect(onReceive.calledOnce).toBe(true);
    const received = onReceive.firstCall.args[0];
    expect(received.name.bytes).toEqual(dialerKey.publicKey.toMultihash().bytes);
    expect(received.record.value).toBe(result.record.value);
    expect(received.pinner.equals(dialerKey.publicKey.toCID())).toBe(true);
    // the slim ReceivedRecord carries nothing else
    expect(Object.keys(received).sort()).toEqual(["name", "pinner", "record"]);
  });

  it("passes the dialer public key to the allow function", async () => {
    const allow: Allow = { allow: sinon.stub().resolves(true) };
    const [outbound, inbound] = await streamPair();

    await Promise.all([
      zzzync(outbound, handlerPeerId, car(helia), result, createSign(dialerKey)),
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
        zzzync(outbound, handlerPeerId, car(helia), result, createSign(dialerKey)),
        makeHandler({ allow })(inbound, connection),
      ]),
    ).rejects.toThrow();

    expect(onReceive.called).toBe(false);
  });

  it("aborts and does not hand off when the challenge key is wrong", async () => {
    const wrongKey = (await generateKeyPair("Ed25519")) as SupportedPrivateKey;
    const [outbound, inbound] = await streamPair();

    await expect(
      Promise.all([
        zzzync(outbound, handlerPeerId, car(helia), result, createSign(wrongKey)),
        makeHandler()(inbound, connection),
      ]),
    ).rejects.toThrow();

    expect(onReceive.called).toBe(false);
  });

  it("passes the name and record to allowRecord", async () => {
    const allowRecord = sinon.stub().resolves(true);
    const [outbound, inbound] = await streamPair();

    await Promise.all([
      zzzync(outbound, handlerPeerId, car(helia), result, createSign(dialerKey)),
      makeHandler({ allowRecord })(inbound, connection),
    ]);

    expect(allowRecord.calledOnce).toBe(true);
    expect(allowRecord.firstCall.args[0].bytes).toEqual(
      dialerKey.publicKey.toMultihash().bytes,
    );
    expect(allowRecord.firstCall.args[1].value).toBe(result.record.value);
  });

  it("aborts and does not hand off when allowRecord denies", async () => {
    const allowRecord = sinon.stub().resolves(false);
    const [outbound, inbound] = await streamPair();

    await expect(
      Promise.all([
        zzzync(outbound, handlerPeerId, car(helia), result, createSign(dialerKey)),
        makeHandler({ allowRecord })(inbound, connection),
      ]),
    ).rejects.toThrow();

    expect(onReceive.called).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests, watch them fail**

Run: `pnpm -C /home/tabcat/github.com/tabcat/zzzync exec vitest run test/zzzync.test.ts`
Expected: FAIL - the current handler still takes `ipns` as its 2nd arg, so `makeHandler()` mis-wires arguments (the importer is read as `ipns`), the handoff misbehaves, and the new `allowRecord` tests have no hook to call. (Failures, not a clean pass.)

- [ ] **Step 3: Slim `ReceivedRecord` and add `allowRecord` to the options**

In `/home/tabcat/github.com/tabcat/zzzync/src/handler.ts`, replace the `CreateHandlerOptions` interface and the `ReceivedRecord` interface with:

```ts
export interface CreateHandlerOptions extends ReadCarFileOptions {
  allow?: Allow;
  /**
   * Decide whether to accept `record` for `name`. The authoritative downgrade
   * guard: reject (return false) to abort the stream before the CAR is imported.
   * ice-queen wires this to its registry.
   */
  allowRecord?(
    name: IpnsMultihash,
    record: IPNSRecord,
    options?: AbortOptions,
  ): boolean | Promise<boolean>;
}

/**
 * A record received and validated by the handler, ready for the caller to pin
 * and publish to routers.
 */
export interface ReceivedRecord {
  /** The dialer's IPNS key. */
  name: IpnsMultihash;
  /** The received, signature-validated IPNS record. */
  record: IPNSRecord;
  /** The dialer's libp2p key, used as the pinner. */
  pinner: Libp2pKey;
}
```

- [ ] **Step 4: Delete `selectRemoteRecord`**

In `/home/tabcat/github.com/tabcat/zzzync/src/handler.ts`, delete the entire `selectRemoteRecord` function (the block starting with its doc comment `/** Resolve the local record ... */` and `async function selectRemoteRecord(` through its closing `}`).

- [ ] **Step 5: Replace `createZzzyncHandler` with the new flow**

In `/home/tabcat/github.com/tabcat/zzzync/src/handler.ts`, replace the entire `export const createZzzyncHandler = ...` arrow assignment with:

```ts
export const createZzzyncHandler =
  (
    handlerPeerId: PeerId,
    importer: Pick<Car, "import">,
    onReceive: OnReceive,
    options: CreateHandlerOptions = {},
  ): StreamHandler =>
  async (stream: Stream, connection: Connection): Promise<void> => {
    const log = _log.newScope(stream.id);
    const { signal, clear } = streamSignal(stream);

    try {
      log("new stream from %s", connection.remotePeer);
      const bs = byteStream(stream);

      let name: IpnsMultihash;
      try {
        name = await readIpnsMultihash(bs, { signal });
      } catch (e) {
        log.error("failed while reading ipns key from stream");
        throw e;
      }
      log("read ipns multihash %t", name.bytes);

      const pinner = await authenticateDialer(
        bs,
        handlerPeerId,
        name,
        options,
        log,
        signal,
      );

      let record: IPNSRecord;
      try {
        record = await readIpnsRecord(bs, name, { signal });
      } catch (e) {
        log.error("failed while reading ipns record from stream");
        throw e;
      }
      log("read ipns record with value %s", record.value);

      if (
        options.allowRecord != null &&
        !(await options.allowRecord(name, record, { signal }))
      ) {
        const e = new Error("ipns record not allowed");
        log.error(e.message);
        stream.abort(e);
        throw e;
      }

      const value = parsedRecordValue(record.value);
      if (value == null) {
        const e = new Error("Failed to parse value. Unsupported codec or hash.");
        stream.abort(e);
        throw e;
      }

      try {
        log("importing car stream");
        await readCarFile(bs, importer, value, options);
        log("finished importing car stream");
      } catch (e) {
        log.error("failed while reading car stream");
        throw e;
      }

      await onReceive({ name, record, pinner }, { signal });
      log("handed off received record");

      await stream.close({ signal });
      log("closed stream");
    } catch (e) {
      log.error("failed while processing stream - %e", e);
      if (e instanceof Error) {
        stream.abort(e);
      } else {
        stream.abort(new Error(String(e)));
      }
    } finally {
      clear();
    }
  };
```

- [ ] **Step 6: Remove now-unused imports from `handler.ts`**

In `/home/tabcat/github.com/tabcat/zzzync/src/handler.ts`:
- Remove `ipnsSelector` from the `@tabcat/helia-ipns` import (delete the line `import { ipnsSelector } from "@tabcat/helia-ipns";`).
- In the `ipns` import block, remove `marshalIPNSRecord` (keep `IPNSRecord`, `multihashToIPNSRoutingKey`, `unmarshalIPNSRecord`).
- Remove `import { equals } from "uint8arrays";`.
- In the `./interface.js` import, remove `HandlerIpns` (keep `IpnsMultihash`, `Libp2pKey`, `UnixFsCID`).

- [ ] **Step 7: Remove `HandlerIpns` from `interface.ts`**

In `/home/tabcat/github.com/tabcat/zzzync/src/interface.ts`:
- Delete the `import type { IPNS } from "@tabcat/helia-ipns";` line.
- Delete the `HandlerIpns` type and its doc comment (the block `/** The subset of Helia's IPNS interface ... */ export type HandlerIpns = Pick<IPNS, "resolve" | "republish">;`).

- [ ] **Step 8: Confirm nothing else references `HandlerIpns`**

Run: `grep -rn "HandlerIpns" /home/tabcat/github.com/tabcat/zzzync/src /home/tabcat/github.com/tabcat/zzzync/test`
Expected: no matches. (If any remain, they are stale and must be removed.)

- [ ] **Step 9: Run the handler tests, watch them pass**

Run: `pnpm -C /home/tabcat/github.com/tabcat/zzzync exec vitest run test/zzzync.test.ts`
Expected: PASS (all 6 tests).

- [ ] **Step 10: Build and run the full zzzync suite**

Run: `pnpm -C /home/tabcat/github.com/tabcat/zzzync build`
Expected: clean `tsc` (no unused-import or type errors).
Run: `pnpm -C /home/tabcat/github.com/tabcat/zzzync test`
Expected: all green.

- [ ] **Step 11: Commit**

```bash
git -C /home/tabcat/github.com/tabcat/zzzync add src/handler.ts src/interface.ts test/zzzync.test.ts
git -C /home/tabcat/github.com/tabcat/zzzync commit -m "refactor: handler receives+validates+hands off, adds allowRecord, drops ipns"
```

---

## Task 3: ice-queen - the `republishing-store`

**Files:**
- Modify: `/home/tabcat/github.com/tabcat/ice-queen/package.json` (add `cborg` dep, `datastore-core` devDep)
- Create: `/home/tabcat/github.com/tabcat/ice-queen/src/republishing-store.ts`
- Test: `/home/tabcat/github.com/tabcat/ice-queen/test/republishing-store.test.ts`

- [ ] **Step 1: Add the dependencies**

Run: `pnpm -C /home/tabcat/github.com/tabcat/ice-queen add cborg`
Run: `pnpm -C /home/tabcat/github.com/tabcat/ice-queen add -D datastore-core`
Expected: `cborg` in `dependencies`, `datastore-core` in `devDependencies`, install succeeds.

- [ ] **Step 2: Write the failing store test**

Create `/home/tabcat/github.com/tabcat/ice-queen/test/republishing-store.test.ts`:

```ts
import { generateKeyPair } from "@libp2p/crypto/keys";
import type { IPNSRecord } from "@tabcat/helia-ipns";
import { publicKeyAsIpnsMultihash } from "@tabcat/zzzync/utils";
import type { IpnsMultihash, Libp2pKey } from "@tabcat/zzzync/interface";
import { MemoryDatastore } from "datastore-core";
import { createIPNSRecord } from "ipns";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createRepublishingStore,
  toIpnsMultihash,
  toLibp2pKey,
} from "../src/republishing-store.ts";
import type { RepublishingEntry } from "../src/republishing-store.ts";

async function rawCid(text: string): Promise<CID> {
  const digest = await sha256.digest(new TextEncoder().encode(text));
  return CID.createV1(raw.code, digest);
}

let name: IpnsMultihash;
let pinner: Libp2pKey;
let record: IPNSRecord;
let value: CID;

beforeAll(async () => {
  const key = await generateKeyPair("Ed25519");
  const ipnsMultihash = publicKeyAsIpnsMultihash(key.publicKey);
  if (ipnsMultihash == null) throw new Error("expected ipns multihash");
  name = ipnsMultihash;
  pinner = toLibp2pKey(key.publicKey.toCID().bytes);
  value = await rawCid("content v1");
  record = await createIPNSRecord(key, value, 0, 3_600_000);
});

describe("toIpnsMultihash / toLibp2pKey", () => {
  it("round-trips valid bytes", () => {
    expect(toIpnsMultihash(name.bytes).bytes).toEqual(name.bytes);
    expect(toLibp2pKey(pinner.bytes).equals(pinner)).toBe(true);
  });

  it("rejects a non-identity multihash", () => {
    // value is a sha2-256 raw CID, not an identity multihash
    expect(() => toIpnsMultihash(value.multihash.bytes)).toThrow();
  });

  it("rejects a non-libp2p-key CID", () => {
    expect(() => toLibp2pKey(value.bytes)).toThrow();
  });
});

describe("createRepublishingStore", () => {
  it("round-trips an entry through put/get", async () => {
    const store = createRepublishingStore(new MemoryDatastore());
    const entry: RepublishingEntry = {
      record,
      pinner,
      pinnedValue: value,
      status: "republishing",
      updatedAt: 1_700_000_000_000,
    };
    await store.put(name, entry);

    const got = await store.get(name);
    expect(got).toBeDefined();
    expect(got?.record.value).toBe(record.value);
    expect(got?.pinner.equals(pinner)).toBe(true);
    expect(got?.pinnedValue?.equals(value)).toBe(true);
    expect(got?.status).toBe("republishing");
    expect(got?.updatedAt).toBe(1_700_000_000_000);
  });

  it("omits pinnedValue and reason when unset, preserves reason when set", async () => {
    const store = createRepublishingStore(new MemoryDatastore());
    await store.put(name, {
      record,
      pinner,
      status: "pin-error",
      reason: "no blocks",
      updatedAt: 1,
    });
    const got = await store.get(name);
    expect(got?.pinnedValue).toBeUndefined();
    expect(got?.reason).toBe("no blocks");
  });

  it("returns undefined for a missing name", async () => {
    const store = createRepublishingStore(new MemoryDatastore());
    expect(await store.get(name)).toBeUndefined();
  });

  it("lists every entry with its name", async () => {
    const store = createRepublishingStore(new MemoryDatastore());
    await store.put(name, { record, pinner, status: "init", updatedAt: 1 });

    const all = await store.list();
    expect(all).toHaveLength(1);
    expect(all[0]?.name.bytes).toEqual(name.bytes);
    expect(all[0]?.entry.record.value).toBe(record.value);
  });

  it("deletes an entry", async () => {
    const store = createRepublishingStore(new MemoryDatastore());
    await store.put(name, { record, pinner, status: "init", updatedAt: 1 });
    await store.delete(name);
    expect(await store.get(name)).toBeUndefined();
    expect(await store.list()).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run the test, watch it fail**

Run: `pnpm -C /home/tabcat/github.com/tabcat/ice-queen exec vitest run test/republishing-store.test.ts`
Expected: FAIL - `../src/republishing-store.ts` does not exist.

- [ ] **Step 4: Implement the store**

Create `/home/tabcat/github.com/tabcat/ice-queen/src/republishing-store.ts`:

```ts
import type { IPNSRecord } from "@tabcat/helia-ipns";
import {
  CID_VERSION_1,
  CODEC_IDENTITY,
  CODEC_LIBP2P_KEY,
} from "@tabcat/zzzync/constants";
import type { IpnsMultihash, Libp2pKey } from "@tabcat/zzzync/interface";
import * as cborg from "cborg";
import { Key } from "interface-datastore";
import type { Datastore } from "interface-datastore";
import { marshalIPNSRecord, unmarshalIPNSRecord } from "ipns";
import { base36 } from "multiformats/bases/base36";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";

const PREFIX = "/ice-queen/republishing/";

/** Status of the durable reconciliation toward an entry's record. */
export type RepublishingStatus =
  | "init"
  | "pinning"
  | "publishing"
  | "republishing"
  | "pin-error";

/**
 * One name the daemon maintains. The registry is the source of truth: `record`
 * is the desired state, `pinnedValue` the applied (actually-pinned) state. The
 * current value/version are derived from `record` and not stored.
 */
export interface RepublishingEntry {
  record: IPNSRecord;
  pinner: Libp2pKey;
  /** The value currently pinned; only the reconciler changes it. */
  pinnedValue?: CID;
  status: RepublishingStatus;
  /** Error message; only meaningful when `status` is "pin-error". */
  reason?: string;
  /** Epoch ms, set on each receive. */
  updatedAt: number;
}

export interface RepublishingStore {
  put(name: IpnsMultihash, entry: RepublishingEntry): Promise<void>;
  get(name: IpnsMultihash): Promise<RepublishingEntry | undefined>;
  delete(name: IpnsMultihash): Promise<void>;
  list(): Promise<Array<{ name: IpnsMultihash; entry: RepublishingEntry; }>>;
}

/** Validate identity-multihash bytes and brand them as an IpnsMultihash. */
export function toIpnsMultihash(bytes: Uint8Array): IpnsMultihash {
  const digest = Digest.decode(bytes);
  if (digest.code !== CODEC_IDENTITY) {
    throw new Error(
      `expected identity multihash, got code 0x${digest.code.toString(16)}`,
    );
  }
  // validated above: an identity-coded digest is an IpnsMultihash
  return digest as IpnsMultihash;
}

/** Validate libp2p-key CID bytes and brand them as a Libp2pKey. */
export function toLibp2pKey(bytes: Uint8Array): Libp2pKey {
  const cid = CID.decode(bytes);
  if (
    cid.code !== CODEC_LIBP2P_KEY ||
    cid.multihash.code !== CODEC_IDENTITY ||
    cid.version !== CID_VERSION_1
  ) {
    throw new Error("expected a libp2p-key CID (0x72 / identity / v1)");
  }
  // validated above
  return cid as Libp2pKey;
}

interface StoredEntry {
  name: Uint8Array;
  record: Uint8Array;
  pinner: Uint8Array;
  pinnedValue?: Uint8Array;
  status: string;
  reason?: string;
  updatedAt: number;
}

function keyFor(name: IpnsMultihash): Key {
  return new Key(PREFIX + base36.encode(name.bytes));
}

function encode(name: IpnsMultihash, entry: RepublishingEntry): Uint8Array {
  const stored: StoredEntry = {
    name: name.bytes,
    record: marshalIPNSRecord(entry.record),
    pinner: entry.pinner.bytes,
    status: entry.status,
    updatedAt: entry.updatedAt,
  };
  if (entry.pinnedValue != null) stored.pinnedValue = entry.pinnedValue.bytes;
  if (entry.reason != null) stored.reason = entry.reason;
  return cborg.encode(stored);
}

function decode(
  bytes: Uint8Array,
): { name: IpnsMultihash; entry: RepublishingEntry; } {
  const stored = cborg.decode(bytes) as StoredEntry;
  const entry: RepublishingEntry = {
    record: unmarshalIPNSRecord(stored.record),
    pinner: toLibp2pKey(stored.pinner),
    // our own controlled enum, written by encode() above
    status: stored.status as RepublishingStatus,
    updatedAt: stored.updatedAt,
  };
  if (stored.pinnedValue != null) entry.pinnedValue = CID.decode(stored.pinnedValue);
  if (stored.reason != null) entry.reason = stored.reason;
  return { name: toIpnsMultihash(stored.name), entry };
}

/**
 * Datastore-backed registry of the names the daemon republishes, keyed by name.
 * Entries are kept (not deleted on success); the terminal success state is
 * `status: "republishing"`.
 */
export function createRepublishingStore(datastore: Datastore): RepublishingStore {
  return {
    async put(name, entry) {
      await datastore.put(keyFor(name), encode(name, entry));
    },
    async get(name) {
      try {
        return decode(await datastore.get(keyFor(name))).entry;
      } catch (e) {
        if (e instanceof Error && e.name === "NotFoundError") return undefined;
        throw e;
      }
    },
    async delete(name) {
      await datastore.delete(keyFor(name));
    },
    async list() {
      const entries: Array<{ name: IpnsMultihash; entry: RepublishingEntry; }> = [];
      for await (const { value } of datastore.query({ prefix: PREFIX })) {
        entries.push(decode(value));
      }
      return entries;
    },
  };
}
```

- [ ] **Step 5: Run the test, watch it pass**

Run: `pnpm -C /home/tabcat/github.com/tabcat/ice-queen exec vitest run test/republishing-store.test.ts`
Expected: PASS (all store + constructor tests).

- [ ] **Step 6: Commit**

```bash
git -C /home/tabcat/github.com/tabcat/ice-queen add package.json pnpm-lock.yaml src/republishing-store.ts test/republishing-store.test.ts
git -C /home/tabcat/github.com/tabcat/ice-queen commit -m "feat: add cbor republishing-store registry with smart-constructors"
```

---

## Task 4: ice-queen - publisher rewrite

**Files:**
- Test: `/home/tabcat/github.com/tabcat/ice-queen/test/publisher.test.ts` (create)
- Modify: `/home/tabcat/github.com/tabcat/ice-queen/src/publisher.ts` (full rewrite)
- Delete: `/home/tabcat/github.com/tabcat/ice-queen/src/pending-store.ts`

The publisher exposes `{ allowRecord, onReceive, resumePins, resumePublishes, idle, stop }`. Per-name work is serialized with the keyed mutex (reused from zzzync). `onReceive` does one atomic registry put under the mutex (re-validating against the stored record); the background `pinThenPublish` reconciles applied state toward the record (offline-write the record, pin the new value, unpin the old, then publish), with pin failures recorded as `pin-error` and never publishing.

- [ ] **Step 1: Write the failing publisher test**

Create `/home/tabcat/github.com/tabcat/ice-queen/test/publisher.test.ts`:

```ts
import type { Pins } from "@helia/interface";
import { generateKeyPair } from "@libp2p/crypto/keys";
import type { IPNS, IPNSRecord } from "@tabcat/helia-ipns";
import { publicKeyAsIpnsMultihash } from "@tabcat/zzzync/utils";
import type { IpnsMultihash, Libp2pKey } from "@tabcat/zzzync/interface";
import { MemoryDatastore } from "datastore-core";
import { createIPNSRecord } from "ipns";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { beforeEach, describe, expect, it } from "vitest";
import { createRepublishingStore } from "../src/republishing-store.ts";
import { toLibp2pKey } from "../src/republishing-store.ts";
import { createPublisher } from "../src/publisher.ts";

async function rawCid(text: string): Promise<CID> {
  const digest = await sha256.digest(new TextEncoder().encode(text));
  return CID.createV1(raw.code, digest);
}

// A fake Pins where add() fails for any CID in `failFor`, succeeds otherwise.
// Records pinned/unpinned CIDs so tests can assert reconciliation.
function fakePins(failFor: Set<string> = new Set()) {
  const pinned = new Set<string>();
  const pins = {
    add: async function* (cid: CID) {
      if (failFor.has(cid.toString())) throw new Error("no blocks");
      pinned.add(cid.toString());
    },
    rm: async function* (cid: CID) {
      pinned.delete(cid.toString());
    },
    get: async () => { throw Object.assign(new Error("nf"), { name: "NotFoundError" }); },
    setMetadata: async () => {},
    isPinned: async (cid: CID) => pinned.has(cid.toString()),
  };
  return { pins: pins as unknown as Pins, pinned };
}

// A fake IPNS.republish: offline writes (no onProgress) are no-ops; publish
// attempts (onProgress present) emit `peers` distinct PUT_VALUE responses.
function fakeIpns(peers: number) {
  let publishAttempts = 0;
  const ipns = {
    async republish(_name: unknown, options?: {
      offline?: boolean;
      onProgress?: (evt: { type: string; detail?: unknown; }) => void;
    }): Promise<{ record: IPNSRecord; }> {
      if (options?.onProgress != null) {
        publishAttempts++;
        for (let i = 0; i < peers; i++) {
          options.onProgress({
            type: "kad-dht:query:peer-response",
            detail: { from: { toString: () => `peer-${i}` }, messageName: "PUT_VALUE" },
          });
        }
      }
      return { record: {} as IPNSRecord };
    },
  };
  return { ipns: ipns as unknown as Pick<IPNS, "republish">, getPublishAttempts: () => publishAttempts };
}

let name: IpnsMultihash;
let pinner: Libp2pKey;
let key: Awaited<ReturnType<typeof generateKeyPair>>;
let v1: CID;
let v2: CID;
let recordV1: IPNSRecord;
let recordV2: IPNSRecord;

beforeEach(async () => {
  key = await generateKeyPair("Ed25519");
  const ipnsMultihash = publicKeyAsIpnsMultihash(key.publicKey);
  if (ipnsMultihash == null) throw new Error("expected ipns multihash");
  name = ipnsMultihash;
  pinner = toLibp2pKey(key.publicKey.toCID().bytes);
  v1 = await rawCid("content v1");
  v2 = await rawCid("content v2");
  recordV1 = await createIPNSRecord(key, v1, 0, 3_600_000);
  recordV2 = await createIPNSRecord(key, v2, 1, 3_600_000);
});

describe("publisher.allowRecord", () => {
  it("allows when there is no existing entry", async () => {
    const datastore = new MemoryDatastore();
    const { ipns } = fakeIpns(10);
    const { pins } = fakePins();
    const publisher = createPublisher({ datastore, ipns, pins });
    expect(await publisher.allowRecord(name, recordV1)).toBe(true);
  });

  it("rejects an older record and allows a newer one", async () => {
    const datastore = new MemoryDatastore();
    const store = createRepublishingStore(datastore);
    await store.put(name, { record: recordV2, pinner, status: "republishing", updatedAt: 1 });
    const { ipns } = fakeIpns(10);
    const { pins } = fakePins();
    const publisher = createPublisher({ datastore, ipns, pins });

    expect(await publisher.allowRecord(name, recordV1)).toBe(false); // older
    expect(await publisher.allowRecord(name, recordV2)).toBe(true); // equal/same
  });
});

describe("publisher.onReceive", () => {
  it("persists the record, pins the value, and reaches republishing", async () => {
    const datastore = new MemoryDatastore();
    const { ipns } = fakeIpns(10);
    const { pins, pinned } = fakePins();
    const publisher = createPublisher({ datastore, ipns, pins });

    await publisher.onReceive({ name, record: recordV1, pinner });
    await publisher.idle();

    const entry = await createRepublishingStore(datastore).get(name);
    expect(entry?.status).toBe("republishing");
    expect(entry?.pinnedValue?.equals(v1)).toBe(true);
    expect(entry?.record.value).toBe(recordV1.value);
    expect(pinned.has(v1.toString())).toBe(true);
  });

  it("records pin-error and does not publish when pinning fails", async () => {
    const datastore = new MemoryDatastore();
    const { ipns, getPublishAttempts } = fakeIpns(10);
    const { pins } = fakePins(new Set([v1.toString()]));
    const publisher = createPublisher({ datastore, ipns, pins });

    await publisher.onReceive({ name, record: recordV1, pinner });
    await publisher.idle();

    const entry = await createRepublishingStore(datastore).get(name);
    expect(entry?.status).toBe("pin-error");
    expect(entry?.reason).toBeDefined();
    expect(entry?.pinnedValue).toBeUndefined();
    expect(getPublishAttempts()).toBe(0); // never published
  });

  it("on update pins the new value and unpins the old one", async () => {
    const datastore = new MemoryDatastore();
    const { ipns } = fakeIpns(10);
    const { pins, pinned } = fakePins();
    const publisher = createPublisher({ datastore, ipns, pins });

    await publisher.onReceive({ name, record: recordV1, pinner });
    await publisher.idle();
    await publisher.onReceive({ name, record: recordV2, pinner });
    await publisher.idle();

    const entry = await createRepublishingStore(datastore).get(name);
    expect(entry?.pinnedValue?.equals(v2)).toBe(true);
    expect(pinned.has(v2.toString())).toBe(true);
    expect(pinned.has(v1.toString())).toBe(false); // old value unpinned
  });

  it("ignores a downgrade that slips past allowRecord", async () => {
    const datastore = new MemoryDatastore();
    const { ipns } = fakeIpns(10);
    const { pins } = fakePins();
    const publisher = createPublisher({ datastore, ipns, pins });

    await publisher.onReceive({ name, record: recordV2, pinner });
    await publisher.idle();
    await publisher.onReceive({ name, record: recordV1, pinner }); // older
    await publisher.idle();

    const entry = await createRepublishingStore(datastore).get(name);
    expect(entry?.record.value).toBe(recordV2.value); // newer kept
  });
});

describe("publisher.resumePins", () => {
  it("pins unpinned entries and returns the failure count", async () => {
    const datastore = new MemoryDatastore();
    const store = createRepublishingStore(datastore);
    // a second name whose value will fail to pin
    const key2 = await generateKeyPair("Ed25519");
    const name2 = publicKeyAsIpnsMultihash(key2.publicKey);
    if (name2 == null) throw new Error("expected ipns multihash");
    const pinner2 = toLibp2pKey(key2.publicKey.toCID().bytes);
    const bad = await rawCid("content bad");
    const recordBad = await createIPNSRecord(key2, bad, 0, 3_600_000);

    await store.put(name, { record: recordV1, pinner, status: "init", updatedAt: 1 });
    await store.put(name2, { record: recordBad, pinner: pinner2, status: "init", updatedAt: 1 });

    const { ipns } = fakeIpns(10);
    const { pins, pinned } = fakePins(new Set([bad.toString()]));
    const publisher = createPublisher({ datastore, ipns, pins });

    const failed = await publisher.resumePins();

    expect(failed).toBe(1);
    expect(pinned.has(v1.toString())).toBe(true);
    expect((await store.get(name))?.pinnedValue?.equals(v1)).toBe(true);
    expect((await store.get(name2))?.status).toBe("pin-error");
  });
});
```

- [ ] **Step 2: Run the test, watch it fail**

Run: `pnpm -C /home/tabcat/github.com/tabcat/ice-queen exec vitest run test/publisher.test.ts`
Expected: FAIL - the current `publisher.ts` exports no `allowRecord`, `resumePins` returns `void` not a count, and `onReceive` reads the old `ReceivedRecord` shape (`received.value`). Compile/type/assertion failures.

- [ ] **Step 3: Rewrite `publisher.ts`**

Replace the entire contents of `/home/tabcat/github.com/tabcat/ice-queen/src/publisher.ts` with:

```ts
import type { Pins } from "@helia/interface";
import type { AbortOptions } from "@libp2p/interface";
import { logger } from "@libp2p/logger";
import { ipnsSelector } from "@tabcat/helia-ipns";
import type { IPNS, IPNSRecord } from "@tabcat/helia-ipns";
import type { OnReceive } from "@tabcat/zzzync/handler";
import type { IpnsMultihash, Libp2pKey } from "@tabcat/zzzync/interface";
import { createKeyedMutex } from "@tabcat/zzzync/mutex";
import { pin, unpin } from "@tabcat/zzzync/pins";
import { republishWithRetry } from "@tabcat/zzzync/republish";
import { parsedRecordValue } from "@tabcat/zzzync/utils";
import type { Datastore } from "interface-datastore";
import { marshalIPNSRecord, multihashToIPNSRoutingKey } from "ipns";
import { base36 } from "multiformats/bases/base36";
import type { CID } from "multiformats/cid";
import { createRepublishingStore } from "./republishing-store.ts";

const log = logger("ice-queen:publisher");

const PIN_MAX_ATTEMPTS = 3;

export interface PublisherComponents {
  datastore: Datastore;
  ipns: Pick<IPNS, "republish">;
  pins: Pins;
}

export interface Publisher {
  /** Authoritative downgrade guard, wired to the zzzync handler. */
  allowRecord(
    name: IpnsMultihash,
    record: IPNSRecord,
    options?: AbortOptions,
  ): Promise<boolean>;
  /** The handler hands received records here; one atomic registry put. */
  onReceive: OnReceive;
  /** Pin every entry not yet pinned. Run before GC. Returns the failure count. */
  resumePins(options?: AbortOptions): Promise<number>;
  /** (Re)publish every entry that still needs it. Run after the node starts. */
  resumePublishes(options?: AbortOptions): Promise<void>;
  /** Resolve once all in-flight processing settles. */
  idle(): Promise<void>;
  /** Abort in-flight processing and wait for it to settle. */
  stop(): Promise<void>;
}

/**
 * Owns the durable side of receiving a record. The registry is the source of
 * truth: `onReceive` records the desired `record`; the background reconciles the
 * applied state (`pinnedValue`, the local store, the DHT) toward it under a
 * per-name mutex. Pinning is durable, retried, and failure-aware (a pin failure
 * is recorded and never published).
 */
export function createPublisher(
  { datastore, ipns, pins }: PublisherComponents,
): Publisher {
  const store = createRepublishingStore(datastore);
  const mutex = createKeyedMutex();
  const controller = new AbortController();
  const inFlight = new Set<Promise<void>>();

  const keyOf = (name: IpnsMultihash): string => base36.encode(name.bytes);

  function track(p: Promise<void>): void {
    inFlight.add(p);
    void p.catch(() => {}).finally(() => inFlight.delete(p));
  }

  // ipnsSelector returns the index of the better record; 0 means `incoming`
  // wins (accept), nonzero means `stored` is at least as good (reject downgrade).
  function incomingWins(
    name: IpnsMultihash,
    incoming: IPNSRecord,
    stored: IPNSRecord,
  ): boolean {
    const selected = ipnsSelector(multihashToIPNSRoutingKey(name), [
      marshalIPNSRecord(incoming),
      marshalIPNSRecord(stored),
    ]);
    return selected === 0;
  }

  async function pinValue(
    value: CID,
    pinner: Libp2pKey,
    signal?: AbortSignal,
  ): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= PIN_MAX_ATTEMPTS; attempt++) {
      signal?.throwIfAborted();
      try {
        await pin(pins, pinner, value, { signal });
        return;
      } catch (err) {
        if (signal?.aborted === true) throw err;
        lastErr = err;
        log.error("pin attempt %d for %c failed - %e", attempt, value, err);
      }
    }
    throw lastErr;
  }

  // Reconcile applied state toward the stored record. Per-name serial.
  async function pinThenPublish(
    name: IpnsMultihash,
    options: AbortOptions,
  ): Promise<void> {
    const { signal } = options;
    await mutex.acquire(keyOf(name), async () => {
      const entry = await store.get(name);
      if (entry == null) return;

      const value = parsedRecordValue(entry.record.value);
      if (value == null) {
        log.error("entry for %t has an unparseable value, skipping", name.bytes);
        return;
      }

      // serve the record locally so the fetch lookup finds it and helia upkeep
      // maintains it
      await ipns.republish(name, {
        record: entry.record,
        offline: true,
        skipResolution: true,
        signal,
      });

      let pinnedValue = entry.pinnedValue;
      if (pinnedValue == null || !pinnedValue.equals(value)) {
        await store.put(name, { ...entry, status: "pinning" });
        try {
          await pinValue(value, entry.pinner, signal);
        } catch (err) {
          await store.put(name, {
            ...entry,
            status: "pin-error",
            reason: String(err),
          });
          log.error(
            "CRITICAL: pin of %c for %c failed; content may be missing - %e",
            value,
            entry.pinner,
            err,
          );
          return; // do not publish
        }
        if (pinnedValue != null && !pinnedValue.equals(value)) {
          await unpin(pins, entry.pinner, pinnedValue, { signal });
        }
        pinnedValue = value;
        // success: clear any stale pin-error reason
        await store.put(name, {
          record: entry.record,
          pinner: entry.pinner,
          pinnedValue,
          status: "publishing",
          updatedAt: entry.updatedAt,
        });
      } else {
        await store.put(name, { ...entry, status: "publishing" });
      }

      const { reached, peers, attempts } = await republishWithRetry(
        ipns,
        name,
        entry.record,
        { signal },
      );
      if (reached) {
        await store.put(name, {
          record: entry.record,
          pinner: entry.pinner,
          pinnedValue,
          status: "republishing",
          updatedAt: entry.updatedAt,
        });
        log("published %c to enough peers", value);
      } else {
        log(
          "publish of %c reached %d peers in %d attempts, leaving for retry",
          value,
          peers,
          attempts,
        );
      }
    });
  }

  return {
    async allowRecord(name, record) {
      const existing = await store.get(name);
      if (existing == null) return true;
      return incomingWins(name, record, existing.record);
    },

    async onReceive({ name, record, pinner }) {
      await mutex.acquire(keyOf(name), async () => {
        const existing = await store.get(name);
        if (existing != null && !incomingWins(name, record, existing.record)) {
          log("ignored a downgrade for %t", name.bytes);
          return;
        }
        await store.put(name, {
          record,
          pinner,
          ...(existing?.pinnedValue != null
            ? { pinnedValue: existing.pinnedValue }
            : {}),
          status: "init",
          updatedAt: Date.now(),
        });
        log("recorded %s for %t", record.value, name.bytes);
      });
      track(pinThenPublish(name, { signal: controller.signal }));
    },

    async resumePins(options) {
      const signal = options?.signal ?? controller.signal;
      const entries = await store.list();
      let failed = 0;
      for (const { name } of entries) {
        await mutex.acquire(keyOf(name), async () => {
          const entry = await store.get(name);
          if (entry == null) return;
          const value = parsedRecordValue(entry.record.value);
          if (value == null) {
            failed++;
            return;
          }
          if (entry.pinnedValue?.equals(value) === true) return; // already pinned
          try {
            await pinValue(value, entry.pinner, signal);
            if (entry.pinnedValue != null && !entry.pinnedValue.equals(value)) {
              await unpin(pins, entry.pinner, entry.pinnedValue, { signal });
            }
            await store.put(name, {
              record: entry.record,
              pinner: entry.pinner,
              pinnedValue: value,
              status: "publishing",
              updatedAt: entry.updatedAt,
            });
          } catch (err) {
            failed++;
            await store.put(name, {
              ...entry,
              status: "pin-error",
              reason: String(err),
            });
            log.error(
              "CRITICAL: pin of %c for %c failed during resume - %e",
              value,
              entry.pinner,
              err,
            );
          }
        });
      }
      log("resumePins: %d entries, %d failed", entries.length, failed);
      return failed;
    },

    async resumePublishes(options) {
      const signal = options?.signal ?? controller.signal;
      const entries = await store.list();
      for (const { name, entry } of entries) {
        if (entry.status === "republishing") continue; // already done
        track(pinThenPublish(name, { signal }));
      }
    },

    async idle() {
      await Promise.allSettled([...inFlight]);
    },

    async stop() {
      log("stopping publisher, %d job(s) in flight", inFlight.size);
      controller.abort();
      await Promise.allSettled([...inFlight]);
    },
  };
}
```

Note (known residual, per the spec's "To revisit"): `pinThenPublish` holds the per-name mutex across the network republish, so a concurrent same-name `onReceive` queues behind it. That is the flagged concurrency-hardening item, intentionally left for a dedicated brainstorm.

- [ ] **Step 4: Delete the old pending store**

Run: `git -C /home/tabcat/github.com/tabcat/ice-queen rm src/pending-store.ts`
Expected: file removed. (The new `publisher.ts` imports `./republishing-store.ts`, not `./pending-store.ts`.)

- [ ] **Step 5: Confirm nothing else imports the old store**

Run: `grep -rn "pending-store" /home/tabcat/github.com/tabcat/ice-queen/src`
Expected: no matches.

- [ ] **Step 6: Run the publisher test, watch it pass**

Run: `pnpm -C /home/tabcat/github.com/tabcat/ice-queen exec vitest run test/publisher.test.ts`
Expected: PASS (allowRecord, onReceive success/pin-error/update/downgrade, resumePins failure count).

- [ ] **Step 7: Commit**

```bash
git -C /home/tabcat/github.com/tabcat/ice-queen add src/publisher.ts test/publisher.test.ts
git -C /home/tabcat/github.com/tabcat/ice-queen commit -m "refactor: publisher reconciles registry, pins durably, splits pin/publish failures"
```

---

## Task 5: ice-queen - wire `server.ts` and `daemon.ts`

**Files:**
- Modify: `/home/tabcat/github.com/tabcat/ice-queen/src/server.ts`
- Modify: `/home/tabcat/github.com/tabcat/ice-queen/src/daemon.ts`

These are wiring changes (no new unit logic); they are verified by `pnpm typecheck` and the manual daemon smoke in Task 6.

- [ ] **Step 1: Update the handler construction in `server.ts`**

In `/home/tabcat/github.com/tabcat/ice-queen/src/server.ts`, replace the `createZzzyncHandler(...)` call inside `registerZzzyncHandler(...)` with the new signature (drop the `name` arg; pass `allowRecord`):

```ts
  const unregisterHandler = await registerZzzyncHandler(
    components.libp2p,
    createZzzyncHandler(
      components.libp2p.peerId,
      car(components),
      publisher.onReceive,
      { ...options, allowRecord: publisher.allowRecord },
    ),
    options,
  );
```

Leave `const name = ipns(components)` and `createPublisher({ datastore: components.datastore, ipns: name, pins: components.pins })` as they are: the publisher still needs `ipns.republish` for the offline write inside `pinThenPublish`.

- [ ] **Step 2: Gate GC on the pin failure count in `daemon.ts`**

In `/home/tabcat/github.com/tabcat/ice-queen/src/daemon.ts`, replace the recovery block (the `log("resuming pending pins...")` through `await helia.gc();` section) with:

```ts
  // resume pinning unfinished work before the node starts accepting pushes, then
  // collect orphan blocks only if every pin succeeded. A pin failure means some
  // of an entry's blocks are unpinned, so GC could collect them: skip GC and log.
  log("resuming pending pins...");
  const failedPins = await publisher.resumePins();
  if (failedPins === 0) {
    log("collecting orphan blocks...");
    await helia.gc();
  } else {
    log.error(
      "CRITICAL: %d pin(s) failed; skipping GC so unpinned blocks are not collected",
      failedPins,
    );
  }
```

Leave the rest of the startup order unchanged: `await helia.start()`, then `void publisher.resumePublishes().catch(...)`.

- [ ] **Step 3: Rebuild zzzync, then typecheck ice-queen**

Run: `pnpm -C /home/tabcat/github.com/tabcat/zzzync build`
Expected: clean (ice-queen resolves zzzync via `dist`, so this must reflect Tasks 1-2).
Run: `pnpm -C /home/tabcat/github.com/tabcat/ice-queen typecheck`
Expected: clean `tsc --noEmit` (no references to the removed `received.value` / `pending-store` / old handler arity).

- [ ] **Step 4: Run the full ice-queen suite**

Run: `pnpm -C /home/tabcat/github.com/tabcat/ice-queen test`
Expected: all green (store + publisher).

- [ ] **Step 5: Commit**

```bash
git -C /home/tabcat/github.com/tabcat/ice-queen add src/server.ts src/daemon.ts
git -C /home/tabcat/github.com/tabcat/ice-queen commit -m "feat: wire allowRecord into the handler and gate GC on pin failures"
```

---

## Task 6: Full verification

**Files:** none (verification only).

- [ ] **Step 1: zzzync build + lint + test**

Run: `pnpm -C /home/tabcat/github.com/tabcat/zzzync ci`
Expected: build, lint (dprint), and tests all pass.

- [ ] **Step 2: ice-queen typecheck + lint + test**

Run: `pnpm -C /home/tabcat/github.com/tabcat/ice-queen ci`
Expected: typecheck, lint, and tests all pass.

- [ ] **Step 3: Manual daemon smoke (use the superpowers:verify skill)**

This refactor changes runtime behavior at two surfaces that unit tests stub (the daemon GC gate and the live handler -> publisher handoff). Verify against a running daemon, following the verify skill:

1. Start the daemon against a fresh, throwaway config dir (never a real/live key) and a throwaway publisher key, allowing the throwaway key in the watchlist.
2. Drive an `upload` (push) and confirm from the daemon logs: handler reads the record, `allowRecord` accepts, CAR imports, `onReceive` records the entry, the value is pinned, and a republish is attempted. Confirm a `/ice-queen/republishing/<name>` entry persists with `status` advancing (`init` -> `pinning` -> `publishing`, reaching `republishing` only if >= 10 PUT_VALUE peers are reachable in the sandbox; leaving it at `publishing` is acceptable there).
3. Restart the daemon and confirm the recovery order from the logs: `resumePins` runs, GC runs only when the failure count is 0 (force a pin-error path if feasible and confirm GC is skipped with the CRITICAL log), then `resumePublishes` runs after start.

Capture the daemon log lines as evidence. Note any pin that did not complete (expected to be rare in the sandbox; the DHT >= 10-peer publish may not complete there, which is environmental, not a regression).

- [ ] **Step 4: Final SLOC check (per the track-SLOC preference)**

Run: `grep -rc "" /home/tabcat/github.com/tabcat/zzzync/src/handler.ts` and compare the handler against its pre-refactor size; the handler should be smaller (selectRemoteRecord + the offline write removed). Confirm ice-queen's `src` did not grow without cause (the registry + publisher replace the pending store + old publisher).

---

## Self-Review

**1. Spec coverage:**
- Handler drops `ipns` + `selectRemoteRecord` + offline write, adds `allowRecord`, slims `ReceivedRecord` -> Task 2.
- Export `createKeyedMutex` + `./mutex` subpath -> Task 1.
- Registry store: cbor, `/ice-queen/republishing/`, smart-constructors, entry `{ record, pinner, pinnedValue?, status, reason?, updatedAt }`, value/version derived, entries kept -> Task 3.
- Publisher: `allowRecord` (ipnsSelector), `onReceive` atomic put + re-validate under per-name mutex carrying `pinnedValue` forward, `pinThenPublish` reconcile (offline write, pin new / unpin old, publish), pin failure -> `pin-error` + `reason` + critical log + no publish, `resumePins` returns failure count, `resumePublishes`, `stop` aborts then awaits -> Task 4.
- Daemon GC gated on zero pin failures; recovery order resumePins -> gc -> start -> resumePublishes -> Task 5.
- `server.ts` builds handler without `ipns`, wires `allowRecord` -> Task 5.
- `ipns.republish` left as-is -> unchanged (used for the offline write + republishWithRetry).
- Testing items (handler flow + allowRecord gate; store round-trip + constructors; publisher onReceive/allowRecord/pin-before-publish/pin-error/per-name/resumePins gating) -> Tasks 2-4.

**2. Placeholder scan:** No "TBD"/"handle errors appropriately"/"similar to" placeholders; every code step shows full code; every command states expected output.

**3. Type consistency:** `RepublishingEntry` fields and `RepublishingStatus` match between Task 3 (definition) and Task 4 (use). `createRepublishingStore` API (`put(name, entry)` / `get(name)` / `delete(name)` / `list() -> {name, entry}[]`) is consistent across Tasks 3-4. `toLibp2pKey` / `toIpnsMultihash` exported in Task 3 are imported in Tasks 3-4 tests. `Publisher.resumePins` returns `Promise<number>` in Task 4 and is consumed as a count in Task 5. Handler `createZzzyncHandler(handlerPeerId, importer, onReceive, options)` arity matches Task 2 source, Task 2 tests, and Task 5 `server.ts`. `allowRecord` signature matches between `CreateHandlerOptions` (Task 2) and `Publisher.allowRecord` (Task 4).

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-06-17-publisher-registry-refactor.md`. Two execution options:**

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
