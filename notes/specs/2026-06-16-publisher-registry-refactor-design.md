# Publisher refactor: a registry-as-source-of-truth + record-allow hook

Status: design, pending review
Date: 2026-06-16
Spans: `@tabcat/zzzync` (handler) and `@tabcat/ice-queen` (publisher + daemon)

## Motivation

The receive-callback feature works (verified end to end), but the publisher and
its pending store grew organically and have rough edges surfaced in review:

- The handler resolves the local store (`selectRemoteRecord`) to gate downgrades
  and compute unpin targets, coupling it to ipns state it shouldn't own.
- The pending store duplicated the full record, used hand-rolled JSON+base32
  with bare `as` casts, and was keyed `/zzzync/...` (it's ice-queen's data).
- `process`/`track` were undescriptive; failures were swallowed; pin and publish
  failures weren't distinguished; a pin failure didn't block GC (data-loss risk).
- No durable list of the names the daemon maintains; entries were deleted on
  success, so updates and status queries had nothing to build on.

This refactor makes ice-queen's registry the **source of truth**, shrinks the
handler to pure receive+validate+handoff, and gives pinning the same durable,
retried, failure-aware treatment as republishing.

## Scope

- **zzzync**: handler signature + flow changes, a new `allowRecord` option,
  a slimmer `ReceivedRecord`, removal of `selectRemoteRecord` and the handler's
  `ipns` dependency, and exporting `createKeyedMutex`.
- **ice-queen**: the registry store, the publisher rewrite, and the daemon GC
  gating.
- **Out of scope (future)**: new zzzync protocols to stop republishing a name
  and to return a name's status, both reading this registry.
- **To revisit (dedicated brainstorm)**: hardening the concurrent same-name
  update path. The design here is correct for the common case (no leaked pin, no
  downgrade), but rapid concurrent updates to the same name are expected to be
  *frequent* - actively-updated replicas, not just ENS sites - so the model needs
  its own rock-solid pass before production. The residual noted under Concurrency
  (both CARs imported on a race; handler→`onReceive` not fully serialized) is the
  starting point for that pass.

## zzzync handler

New signature (drops `ipns`):

```ts
createZzzyncHandler(
  handlerPeerId: PeerId,
  importer: Pick<Car, "import">,
  onReceive: OnReceive,
  options?: CreateHandlerOptions,
): StreamHandler
```

Per-stream flow:

1. authenticate the dialer; `options.allow?.allow(publicKey)` (the existing
   key check). → `name`, `pinner` (`publicKeyFromMultihash(name).toCID()`).
2. read the IPNS record and validate its signature (`ipnsValidator`).
3. `options.allowRecord?.(name, record)` - the new record check. Reject (abort
   the stream) if it returns false. This is the authoritative downgrade guard
   (ice-queen wires it to the registry, below).
4. parse `value` from `record.value`; import + verify the CAR (root === value).
5. `await onReceive({ name, record, pinner })`; then close the stream.

Removed: `selectRemoteRecord`, the offline write, and the `ipns` service
dependency. The handler keeps `ipnsValidator` (a function), not the IPNS service.

New option on `CreateHandlerOptions`:

```ts
allowRecord?(
  name: IpnsMultihash,
  record: IPNSRecord,
  options?: AbortOptions,
): boolean | Promise<boolean>
```

`ReceivedRecord` shrinks to:

```ts
interface ReceivedRecord {
  name: IpnsMultihash;
  record: IPNSRecord;
  pinner: Libp2pKey;
}
```

`value` is dropped (the publisher derives it from `record`); `previousValue` /
`valueChanged` are dropped (the publisher derives them from the registry).

Also: export `createKeyedMutex` (currently internal) from the index and a
`./mutex` subpath, so ice-queen can reuse it. `HandlerIpns` is no longer used by
the handler and can be removed. `republishWithRetry`, `countPutValuePeers`,
`pin`, `unpin` are unchanged.

## ice-queen registry (`republishing-store`)

A datastore-backed registry of every name the daemon maintains. **Source of
truth** - the helia-ipns local store becomes a derived copy.

- Prefix `/ice-queen/republishing/<name base36>`.
- `cborg` encoding (helia's pattern), with validating smart-constructors
  (`toIpnsMultihash` / `toLibp2pKey`) so there are no bare `as` casts.
- Entry, keyed by name:

  ```ts
  interface RepublishingEntry {
    record: IPNSRecord;        // current record (source of truth / desired state)
    pinner: Libp2pKey;
    pinnedValue?: CID;         // the value currently pinned (applied state)
    status: "init" | "pinning" | "publishing" | "republishing" | "pin-error";
    reason?: string;           // error message when status is "pin-error"
    updatedAt: number;         // epoch ms, set on each receive
  }
  ```

  The current `value` and `version` are **derived** from `record`
  (`record.value` / `record.sequence`), not stored. `pinnedValue` is the
  separate **applied** state - the value the background has actually pinned -
  which only the background changes (see Concurrency). Entries are **kept** (not
  deleted on success); the terminal success state is `republishing`.

## ice-queen publisher

Exposes `{ allowRecord, onReceive, resumePins, resumePublishes, idle, stop }`,
all wired to the registry. Per-name work is serialized with `createKeyedMutex`
(imported from zzzync), keyed by name: same name serial, different names
concurrent. In-flight jobs are tracked so `idle()`/`stop()` can await them.

- `allowRecord(name, record)`: read the registry entry; `ipnsSelector`-compare
  the incoming record against the stored one; return false for a downgrade
  (older sequence/validity). Default-allow when there's no existing entry.
- `onReceive({ name, record, pinner })` - the durable boundary, **one atomic
  put** under the per-name mutex: read the existing entry, `ipnsSelector`-
  re-validate (reject a downgrade that slipped past `allowRecord`), then write
  `{ record, pinner, pinnedValue: existing?.pinnedValue, status: "init",
  updatedAt }`. It carries `pinnedValue` forward unchanged (it reflects what is
  *actually* pinned; only the background changes it). Return → the handler closes
  the stream. Then schedule background processing.
- background `pinThenPublish(name)` (per-name mutex, sequential) - reconciles the
  applied state toward the record:
  1. `value = parsedRecordValue(entry.record.value)`.
  2. offline-write the record to the local store (so the fetch lookup serves it
     and helia upkeep maintains it).
  3. if `value !== pinnedValue`: pin `value` for `pinner`; if `pinnedValue` was
     set, unpin it; set `pinnedValue = value`. Status `pinning`.
     - **pin failure** (after in-session retries): status `pin-error`, set
       `reason`, **log critical** ("content may be missing"), and **do not
       publish**. Leave the entry for retry.
  4. `republishWithRetry(ipns, name, record)`. Status `publishing` → on success
     `republishing`. Publish shortfall: stay, retried later.
- `resumePins(options)`: pin every entry that isn't pinned yet; returns a
  failure count.
- `resumePublishes(options)`: (re)publish every entry that needs it; background.
- `stop()`: abort the shared signal, then await in-flight (you confirmed
  awaiting is fine).

## ice-queen daemon

Startup order, with GC gated on pins:

1. `const failed = await publisher.resumePins()` (local; before GC).
2. if `failed === 0` → `await helia.gc()`; else **skip GC and log critical**
   (unpinned blocks would otherwise be collected).
3. `await helia.start()`.
4. `void publisher.resumePublishes()` (needs the network; background).

`server.ts` builds the handler without `ipns` and wires both hooks from the
publisher: `createZzzyncHandler(peerId, car(components), publisher.onReceive,
{ allow, allowRecord: publisher.allowRecord, ...streamOpts })`.

## ipns.republish (unchanged)

`@tabcat/helia-ipns` `republish` selects the best of `{candidate, local,
[latest]}` via `ipnsSelector`, so it never downgrades even with
`skipResolution: true`. It does not throw on a downgrade attempt; the throw lives
at ingestion (`allowRecord`). No change needed.

## Concurrency & atomicity

- Per-name serialization via the keyed mutex; cross-name concurrency.
- `onReceive` acquires the per-name mutex and re-validates the record against the
  current entry (`ipnsSelector`) before writing, so two concurrent pushes for the
  same name can't let an older record win the write (the `allowRecord` check and
  the write would otherwise be a time-of-check/time-of-use gap).
- Applied state lives in `pinnedValue` (durable "what is pinned"), not a
  transient unpin target. `onReceive` only updates `record` (desired) and carries
  `pinnedValue` forward; the background reconciles `record.value` against
  `pinnedValue` under the mutex (pin the new, unpin the old, set
  `pinnedValue = value`). This composes under rapid/concurrent updates: chained
  writes V4→V5→V6 before the background runs leave `pinnedValue` at the
  actually-pinned V4, so the background pins V6 and unpins V4 - V5's content is
  simply orphaned (unpinned, GC-collected), with no leaked pin and no lost unpin.
  A transient `previousValue` would lose V4's unpin when V5's write overwrote it;
  `pinnedValue` does not. The registry is the source of truth; the local store,
  pins, and DHT are reconciled from it.
- Residual cost (not a correctness issue): two concurrent pushes for the same name
  both import their CARs, and the losing record's blocks are orphaned + later
  GC-collected. Eliminating that would require holding the per-name lock across
  the handler's CAR import (coupling the handler to ice-queen's mutex), which
  isn't worth it for a rare race.

## Crash-safety / invariants

- A push is acknowledged only after the single atomic registry put; a crash
  before that leaves an errored stream the dialer retries.
- After acknowledgement, pin and publish are retried (the entry persists and
  startup resumes it by status).
- GC never runs while any pin is unfinished (`resumePins` reported a failure, or
  any entry isn't pinned), so pinned-but-unwritten blocks can't be collected.
- Downgrades are rejected at `allowRecord` against the registry (the local store
  may lag and is not authoritative).
- A partial pin is safe to retry: helia's `pins.add` walks the DAG incrementally
  (marking each reached block in the pinned-block index) and writes the root pin
  record *last*, so a failure mid-walk leaves the walked blocks GC-protected but
  `isPinned` false. Retry doesn't double-count - `#updatePinnedBlock` skips a
  block already in its `pinnedBy` for that root, and zzzync serializes same-CID
  pins with a keyed mutex, so a block's count for a given root stays at 1. The GC
  gate protects the not-yet-walked blocks until the retry finishes - which is why
  the gate must be on zero pin failures.
- Residual (for the future stop/remove protocol, not this work): a partial pin
  writes block entries but not the root record, and `rm` requires the root record
  (`datastore.get(pinKey)` throws if absent). So a *never-completed* partial pin's
  blocks can't be `rm`'d until the pin completes - harmless under retry-to-
  completion, but removal of a permanently-failed name must clean up partial pins
  explicitly.

## Testing (TDD)

- zzzync: handler flow with fakes (allow, allowRecord gate rejects a downgrade,
  `onReceive` handoff, no `ipns`); `createKeyedMutex` export. Existing
  `republishWithRetry`/`countPutValuePeers` tests stand.
- ice-queen: registry cbor round-trip + smart-constructors; publisher
  (`onReceive` writes once; `allowRecord` rejects older records via
  `ipnsSelector`; `pinThenPublish` sequential, pin-before-publish; pin failure →
  `pin-error` + `reason` + no publish; per-name serialization; `resumePins`
  failure count gating GC; update path sets/clears `previousValue`).

## Build order

1. zzzync: export `createKeyedMutex` (+ `./mutex` subpath).
2. zzzync: handler refactor (drop `ipns`, add `allowRecord`, slim
   `ReceivedRecord`, remove `selectRemoteRecord`).
3. ice-queen: registry store (cbor, prefix, smart-constructors).
4. ice-queen: publisher rewrite (`allowRecord`, `onReceive`, `pinThenPublish`,
   keyed mutex, status, failure handling, `stop`/`idle`).
5. ice-queen: wire `server.ts` (drop `ipns`, pass `allowRecord`) and `daemon.ts`
   (GC gating + recovery order).

## Settled decisions

- Registry is source of truth; stores the record; entries kept and updateable.
- Applied pin state tracked as a durable `pinnedValue` (not a transient
  `previousValue`), so updates compose safely under concurrency; entry carries an
  `updatedAt` timestamp.
- `ReceivedRecord` = `{ name, record, pinner }`.
- Pin then publish, sequential, per name; concurrent across names via the keyed
  mutex.
- `allowRecord` hook is the authoritative downgrade guard, wired to the registry.
- Handler drops `selectRemoteRecord` and the `ipns` service dependency.
- Pin failure → durable `pin-error` + `reason` + critical log + no publish; GC
  gated on zero pin failures.
- `ipns.republish` left as-is; `stop()` aborts then awaits.
- `/ice-queen/republishing/` namespace; one namespace with a `status` field.
