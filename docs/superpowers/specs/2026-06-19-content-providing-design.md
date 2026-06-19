# Content providing: announce pinned roots to the DHT

Status: design, pending review (rev 2, per review feedback)
Date: 2026-06-19 (revised 2026-06-20)
Scope: `@tabcat/zzzync` (a `provideWithRetry` utility mirroring `republishWithRetry`) and `@tabcat/ice-queen` (publisher reconcile + status + server wiring).

## Motivation

The daemon pins received content but never announces it to the DHT, so although the IPNS record resolves (name -> root CID), no provider record exists for the CID. A fetcher resolves the name but can't discover who holds the content. Verified live: an independent Kubo node resolved the IPNS record but `findprovs <root>` was empty and `ipfs cat <root>` timed out. This adds providing so pinned roots get provider records.

## Key facts (verified against the installed code)

- helia 6.1.4 does NOT auto-provide on blockstore write or pin; the app must call `helia.routing.provide(cid)`.
- `provide(cid)` announces ONE CID. Providing only the ROOT is sufficient: a fetcher finds the root's provider, connects, and bitswaps the whole DAG from it (the daemon pins the full DAG). This is Kubo's `Reprovider.Strategy = "roots"`. So: no DAG walk, no per-block provide, and no disjoint-set unprovide on update.
- The linked dev `@libp2p/kad-dht` v16.3.0 auto-reprovides our own provides (1h loop, reprovide within 24h of the 48h TTL), persists provider records to the datastore, and resumes on restart. So we `provide` ONCE per root and kad-dht keeps it alive - no app-level reprovide loop and no `resumeProvides` sweep.

## Design

### Registry: status-only, no new CID field
- **No `providedValue`.** The root is already `record.value` (desired) and `pinnedValue` (applied); we provide exactly what we pin, so the provided root IS `pinnedValue`. On an update, the old `pinnedValue` is what we `cancelReprovide` and `unpin` (the reconcile already captures it). No duplicate CID is stored.
- **Status gains `providing`**: `init -> pinning -> providing -> publishing -> republishing`. Being at `publishing` or `republishing` means provide reached its threshold. `pin-error` remains the only hard-error status (provide failure is NOT a hard error - see below).

### zzzync: `provideWithRetry`, mirroring `republishWithRetry`
Provide is treated like republish, so it gets the same peer-count + threshold-retry shape (in `zzzync`, next to `republish.ts`):
- `countAddProviderPeers()` - mirror of `countPutValuePeers`; counts distinct `kad-dht:query:peer-response` progress events whose `messageName === "ADD_PROVIDER"` (how many peers stored our provider record).
- `provideWithRetry(routing, value, { minProviders, maxAttempts, signal })` - calls `routing.provide(value, { onProgress })`, counts providers, retries up to `maxAttempts` while below `minProviders`; returns `{ reached, peers, attempts }`. Default `minProviders` proposed 10 (match `republishWithRetry`'s `minPeers`).
- **VERIFY FIRST** (build step 1): that `helia.routing.provide` threads `onProgress` and the kad-dht provide query emits per-peer `ADD_PROVIDER` responses we can count - the same query-event mechanism `republishWithRetry` relies on for `PUT_VALUE`. Confirm before building, like we confirmed the reprovider. If provide does not surface per-peer progress, revisit how "how many servers we wrote to" is measured.

### Publisher reconcile (`pinThenPublish`), pin -> provide -> publish
1. pin `value` (existing); set `pinnedValue = value`; status `pinning`.
2. status `providing`; `provideWithRetry(routing, value)`. On `reached` -> continue. On shortfall -> leave status `providing` and return; the next reconcile / `resumePublishes` retries (a reprovide failure, retried - not a hard error).
3. status `publishing`; `republishWithRetry(...)` -> `republishing` on `reached`, else stay `publishing`.

Open sub-decision: step 2 gating step 3 (proposed yes - "reprovide before republishing" so we don't advertise under-provided content; the downside is a persistent provide shortfall defers the IPNS publish).

### Update teardown
At the pin transition (the existing unpin timing in both `pinThenPublish` and `resumePins`), for the superseded old value: `await routing.cancelReprovide(oldPinnedValue)` then `unpin(oldPinnedValue)` - unprovide before unpin. This keeps the change minimal and crash-safe like the existing proven structure, rather than restructuring both reconcile paths to defer teardown until after the new value is published. The practical dangling window is negligible: unpinned old blocks linger in the blockstore until the next startup GC, and old provider records persist on the DHT (~48h until expiry), so old content stays fetchable the few seconds until the new value is published. A stricter "keep old pinned + provided until the new value is published" variant is possible but materially complicates the commit/crash-safety across `pinThenPublish` + `resumePins`; deferred unless needed.

### Wiring
- Publisher components gain `routing: Pick<Helia["routing"], "provide" | "cancelReprovide">`.
- `server.ts` passes `components.routing` to `createPublisher`.
- No `resumeProvides`: kad-dht reprovides persisted records, and `resumePublishes -> pinThenPublish` re-provides on startup (covers a crash between pin and provide).
- Confirm at implementation that the daemon's libp2p/kad-dht uses the persistent Level datastore (so provider records survive restart); if in-memory, the registry-driven resume re-provides anyway.

## Testing (TDD)

- zzzync: `countAddProviderPeers` (counts ADD_PROVIDER, ignores other messages/events) and `provideWithRetry` (reached on first try; retries to threshold; gives up after maxAttempts; aborts on a pre-aborted signal) - mirror `republish.test.ts`'s fakes.
- ice-queen publisher (fakes): `routing.provide` invoked (via the util) after the pin and before the republish; on update `routing.cancelReprovide(oldRoot)` is called after the new value is published, and the old value is unpinned; a provide shortfall leaves status `providing` (retried) and does not become `pin-error`.
- Live smoke: daemon + upload, then Kubo `ipfs routing findprovs <root>` shows the daemon's peer id, and `ipfs cat <root>` returns the content.

## Build order

1. zzzync: VERIFY provide emits countable `ADD_PROVIDER` progress; then add `countAddProviderPeers` + `provideWithRetry` (+ exports), tests.
2. ice-queen registry: add `providing` to the status union (cbor round-trip already handles the string).
3. ice-queen publisher: add `routing` to components; provide step + `providing` status + teardown (`cancelReprovide` + unpin of old) in `pinThenPublish`; tests.
4. ice-queen `server.ts`: pass `components.routing`.
5. Verify: `pnpm -C zzzync ci` + `pnpm -C ice-queen ci` + live Kubo `findprovs` smoke.

## Settled / open

- Settled: no `providedValue` (status + `pinnedValue`); provide treated like republish (peer-count + threshold-retry, not a hard error); provide before publish; teardown `cancelReprovide` + `unpin` of the old value after the new is published; kad-dht reprovides (no app loop / no `resumeProvides`).
- Open: (1) does a provide shortfall gate the republish (proposed yes); (2) `minProviders` default (proposed 10); (3) confirm provide surfaces countable `ADD_PROVIDER` progress (verify as build step 1).
