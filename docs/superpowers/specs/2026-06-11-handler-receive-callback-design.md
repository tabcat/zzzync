# Handler receive callback + durable, verified initial publish

Status: design, pending review
Date: 2026-06-11

## Motivation

Today `createZzzyncHandler` does pinning, unpinning, and republishing inline,
racing the republish against `ipns:routing:datastore:complete` so it returns as
soon as the record is persisted locally. Three problems:

1. **No verification** that the record actually propagated to the DHT. The
   handler returns on the local write and never confirms the routing layer.
2. **No durability.** If the node goes offline after receiving a record but
   before the initial DHT write lands, the work is lost. There is no record of
   "received but not yet published/pinned".
3. **Wrong owner.** The handler (pure protocol code in zzzync) owns stateful
   orchestration (pin bookkeeping, background republish) that belongs in the
   app daemon (ice-queen).

## Goal

The handler becomes pure receive + validate + persist-locally, then hands the
rest off to an injected `onReceive` callback. ice-queen implements that
callback to durably record the pending work and run two background jobs: pin
the content, and publish the record to the DHT, retrying the **initial** publish
until it reaches at least 10 distinct DHT peers. Ongoing record upkeep is left
to helia-ipns's own republisher (interval based); we own only the initial
publish.

## Scope

In scope:

- **zzzync**: `countPutValuePeers`, `republishWithRetry`, the `onReceive`
  contract, and the handler refactor (drop the `pins` dependency, narrow `ipns`
  to `resolve` + `republish`, replace the inline pin/republish block with a
  call to `onReceive`).
- **ice-queen**: the `onReceive` implementation (durable pending store + the two
  background jobs), and daemon startup recovery with correct GC ordering.

Out of scope:

- Ongoing republish maintenance (helia-ipns's republisher handles it).
- Non-DHT routing backends (delegated HTTP, pubsub). This feature is kad-dht
  specific by nature; the peer count comes from kad-dht query events.
- General GC policy beyond the startup sweep.

## Background: the event vocabulary (verified)

`ipns.republish(name, { record, onProgress, ... })` resolves to `{ record }`.
The DHT put it triggers forwards libp2p kad-dht query progress events through
the same `onProgress`:

- Event `type === 'kad-dht:query:peer-response'`, `detail` is a kad-dht
  `PeerResponseEvent` with `from: PeerId` and `messageName: 'PUT_VALUE'` for each
  peer that accepted the record write. The `messageName` filter matters: the put
  query first runs a `FIND_NODE` lookup that also emits `peer-response` events,
  and those are not record writes.
- These events are not in `RepublishOptions`'s `onProgress` type
  (`RepublishProgressEvents | IPNSRoutingProgressEvents`), but they arrive at
  runtime. `@libp2p/kad-dht` is already a dependency, so we import its
  `PeerResponseEvent` type and `MessageType.PUT_VALUE` for a type guard.

`pins.add(root)` is an `AsyncGenerator<CID>` that walks the DAG after the blocks
exist. Because the received CAR is a complete DAG (the handler verifies every
block descends from root) and no GC runs during normal operation, this walk is
fully local (no network fetch). There is no pin-on-write hook in Helia:
`Car.import` is `drain(blockstore.putMany(...))` against a bare blockstore, and
`Blocks.put` has no pin flag.

## Design

### zzzync: `countPutValuePeers()`

```ts
export interface PutValueCounter {
  // Pass to ipns.republish's onProgress (compose with any existing handler).
  onProgress: (evt: ProgressEvent<any, any>) => void;
  // Distinct peer ids (toString) that acked a PUT_VALUE write.
  readonly peers: Set<string>;
}

export function countPutValuePeers(): PutValueCounter;
```

- `onProgress` ignores everything except `type === 'kad-dht:query:peer-response'`
  with `detail.messageName === 'PUT_VALUE'`, adding `detail.from.toString()` to
  `peers`.
- Typed with a broad `ProgressEvent` param so it stays assignable where
  republish expects its narrower `onProgress` type (contravariance).
- Pure and synchronous; unit-testable by feeding synthetic events.

### zzzync: `republishWithRetry()`

```ts
export interface RepublishWithRetryOptions extends AbortOptions {
  minPeers?: number;     // default 10
  maxAttempts?: number;  // default 3
  // optional backoff between attempts
}

export interface RepublishResult {
  reached: boolean;      // peers.size >= minPeers on the successful attempt
  peers: number;         // distinct PUT_VALUE peers on the last attempt
  attempts: number;
}

export async function republishWithRetry(
  ipns: Pick<IPNS, "republish">,
  name: IpnsMultihash,
  record: IPNSRecord,
  options?: RepublishWithRetryOptions,
): Promise<RepublishResult>;
```

- Per attempt: create a `countPutValuePeers()`, call
  `ipns.republish(name, { record, skipResolution: true, onProgress })`, await it,
  then check `peers.size >= minPeers`.
- Retry up to `maxAttempts` if short. Return as soon as reached.
- This is the piece the worker awaits, never the handler. It provides the
  per-invocation retry; durability across restarts is the store's job (below).
- `ipns` narrowed to `Pick<IPNS, "republish">` (a subset of `HandlerIpns`).

### zzzync: the `onReceive` contract

```ts
export interface ReceivedRecord {
  name: IpnsMultihash;
  record: IPNSRecord;
  value: UnixFsCID;
  pinner: Libp2pKey;
  previousValue: UnixFsCID | null; // for unpin when the value changed
  valueChanged: boolean;
}

export type OnReceive = (
  received: ReceivedRecord,
  options?: AbortOptions,
) => Promise<void>;
```

- The handler `await`s `onReceive` and only closes the stream as success once it
  resolves. The implementation MUST durably persist the pending work before
  resolving. If it throws, the handler aborts the stream so the dialer retries.
- The actual pin and DHT publish happen after `onReceive` resolves, in the
  background. `onReceive` itself only persists intent and returns.

### zzzync: handler refactor

New signature (drops `pins`, adds `onReceive`):

```ts
createZzzyncHandler(
  handlerPeerId: PeerId,
  ipns: HandlerIpns,                // resolve + republish
  importer: Pick<Car, "import">,
  onReceive: OnReceive,
  options?: CreateHandlerOptions,
): StreamHandler
```

Per-stream flow:

1. authenticate dialer -> `name`, `pinner`
2. read + validate IPNS record, parse `value` (UnixFS CID)
3. `selectRemoteRecord` (resolve local, reject if remote is worse, compute
   `valueChanged` + `previousValue`) [uses `ipns.resolve`]
4. import the CAR to the blockstore [uses `importer`; stream-bound]
5. write the record offline to the local datastore
   (`ipns.republish(name, { record, offline: true, skipResolution: true })`) so
   it is immediately resolvable
6. `await onReceive({ name, record, value, pinner, previousValue, valueChanged })`
7. close the stream

The `defer()` + `Promise.race` block is removed. The `localRecordEqual`
short-circuit is kept (if we already hold this exact record locally, skip steps
5 and 6; the pending store from a prior receipt is the safety net).

**Block-on set before success:** (4) CAR fully imported, (5) record written
offline, (6) pending intent persisted. Everything slower (pin walk, DHT publish)
runs after.

### ice-queen: `onReceive` implementation + durable store

A single pending entry per received push, keyed by `name`:

```
key:   <pending-prefix>/<name>
value: { record, value, pinner, previousValue, pinned: false, published: false }
```

backed by ice-queen's existing `LevelDatastore`.

- `onReceive` writes the entry (awaited; this is the durability point) and
  triggers processing, then returns.
- Background processing for an entry:
  - pin `value` for `pinner` (`pins.add` via zzzync's `pin`), and unpin
    `previousValue` if `valueChanged` (`unpin`). On success set `pinned: true`.
  - `republishWithRetry(ipns, name, record, { minPeers: 10 })`. On `reached` set
    `published: true`; if it returns `reached: false` (attempts exhausted),
    leave `published: false` so the next trigger or the next startup retries it.
    helia-ipns's republisher maintains presence in the meantime.
  - When both `pinned` and `published` are true, delete the entry.
- Independent flags mean a restart re-pins only if `!pinned` and re-publishes
  only if `!published`, so finished halves are never repeated.

### ice-queen: daemon startup recovery + GC ordering

On daemon start, in this order:

1. load all pending entries
2. resume pending **pins** first (and kick the pending republishes)
3. run **GC** of orphan blocks
4. register the handler (start accepting new pushes)

The ordering is required: GC removes unpinned blocks, and a pending-but-unpinned
entry points at unpinned blocks. Pinning before GC ensures those blocks survive;
GC then removes only true orphans (e.g. a CAR import that crashed mid-stream,
which never produced a pending entry and whose stream errored anyway).
Republishes may continue in the background past startup.

## Crash-safety invariants

- A record is only acknowledged to the dialer (stream closed success) after the
  CAR is imported, the record is written locally, and the pending entry is
  persisted. A crash before that point leaves an errored stream the dialer
  retries; no half state is acknowledged.
- After acknowledgement, pin and DHT publish are guaranteed to be retried,
  because the pending entry survives restarts and the startup recovery resumes
  it.
- Assumption: no GC runs against unpinned-but-pending blocks during normal
  operation. GC happens only at startup, after the pending-pin resume.

## Testing

TDD, tests first.

- zzzync `countPutValuePeers`: feed synthetic progress events (PUT_VALUE
  peer-responses, FIND_NODE peer-responses, unrelated events, duplicate peers);
  assert only distinct PUT_VALUE `from` are counted.
- zzzync `republishWithRetry`: fake `ipns.republish` that emits N PUT_VALUE
  peer-responses via the passed `onProgress`; assert it retries when N <
  minPeers, stops when reached, and respects `maxAttempts` and the abort signal.
- zzzync handler: fake `ipns`, `importer`, and `onReceive`; assert the flow,
  that `onReceive` is awaited before close, that an `onReceive` throw aborts the
  stream, and that the `localRecordEqual` short-circuit holds.
- ice-queen: pending store persistence; startup recovery resumes only unfinished
  halves; pin-before-GC ordering.

## Build order

1. zzzync `countPutValuePeers` (self-contained, pure).
2. zzzync `republishWithRetry` (uses 1).
3. zzzync handler refactor + `onReceive` contract (uses 2 indirectly via the
   caller; the handler itself only calls `onReceive`).
4. ice-queen integration: durable store, the two background jobs, daemon startup
   recovery.

Steps 1-3 are buildable and testable in zzzync with no ice-queen dependency.

## Settled decisions

- Success bar = at least 10 distinct DHT peers acking PUT_VALUE (configurable
  `minPeers`, default 10).
- Single pending entry per push with `pinned`/`published` flags (not two stores).
- The worker loop + persistence live in ice-queen; zzzync provides the
  mechanisms (`countPutValuePeers`, `republishWithRetry`, `pin`/`unpin`) and the
  `onReceive` type.
- Write offline first in the handler, then hand off.
- GC on startup, after the pending-pin resume, before handler registration.
- Keep the `localRecordEqual` short-circuit.
- No pin-during-import: Helia has no pin-on-write hook, replicating its pin/GC
  block accounting would couple to internals, and inline pinning would block
  stream close on the slow DAG walk we are deliberately deferring.
