# zzzync CAR-reader + handshake hardening (v6 pre-release)

Date: 2026-06-22
Status: approved, executing

## Context

Pre-release audit of zzzync v6.0.0 found one integrity bug (incomplete DAGs
accepted), one DoS (no read timeout), one correctness bug (secp256k1 handshake
broken), a fail-open `allow` default, missing size bounds, and several smaller
hardening items. This spec covers fixing all of them plus the verified CAR
reader rework.

Threat model: the handler reads from UNTRUSTED remote dialers and pins/serves
the result as a "verifiable replica of the original publisher." Every defense is
on the handler's untrusted-input path.

## Goals

- Verified CAR reader that proves completeness and integrity of a deduped DAG.
- Idle read timeouts (handler + dialer) and a flat dialer ack timeout; all
  configurable.
- secp256k1 dialers can authenticate.
- `allow` is mandatory (no fail-open).
- Explicit, finite size bounds independent of dependency defaults.
- Drop the `@tabcat/helia-ipns` dependency (types only, no republishing used).

## Non-goals / out of scope

- O(frontier) CAR verification via topologically-ordered CARs. Rejected:
  neither DFS nor BFS is topological (unequal-length paths to a shared node), and
  a true topo sort needs a pre-pass (Kahn) that defeats streaming. Two-set with a
  block-count cap is the chosen bound instead.
- Global cross-connection concurrency limiting (only per-connection
  `maxInboundStreams` is set here).

## Design

### 1. Verified CAR reader (`readCarFile`, handler.ts)

Spec deduped CARs only (matches the dialer, which dedupes on export). Verify with
two sets:

- `wanted: Set<string>` (referenced, not yet received), seeded with the root key.
- `received: Set<string>` (already imported).

Key = `cid.toV1().toString(base32)`: preserves codec (raw vs dag-pb differ, so a
codec downgrade is rejected) and is version/base stable.

Per block, in stream order:
1. compute `key`.
2. if `key` not in `wanted` -> throw (unreferenced or duplicate block).
3. enforce `bytes.byteLength <= MAX_BLOCK_BYTES` and a running
   `byteLength <= maxByteLength`, and `++blockCount <= maxBlockCount`.
4. `create({ bytes, cid, codec, hasher })` (rehash; tampered bytes throw).
5. move `key` from `wanted` to `received`.
6. for every link in `block.links()` (all codecs, not just dag-pb): if the link
   key is not in `received` and not in `wanted`, add it to `wanted`.
7. yield block.

After the loop: `if (wanted.size > 0) throw` (incomplete DAG).

`block.links()` is called for every codec, so dag-pb and dag-cbor links are
walked and raw (no links) is a natural leaf. No `if (codec.code === DAG_PB)`
special case.

### 2. Codec support (`getCodec`, `parsedRecordValue`, utils.ts)

- `getCodec`: dag-pb, dag-cbor, raw. Any other codec -> throw (fail closed; no
  silent raw fallback).
- `parsedRecordValue`: require the value to start with `IPFS_PREFIX` before
  slicing; accept root codec dag-pb, raw, or dag-cbor; sha256 hasher only.

### 3. Timeouts (configurable)

Idle read timeout (handler + dialer): a session AbortSignal that fires after
`idleTimeoutMs` with no read progress, reset after every successful `bs.read`.
Implemented as a wrapper that resets the timer on each read; the existing reads
already pass the session signal, plus we fix the two reads that drop it
(`readByte` first byte, `readVarintPrefixed` payload).

Flat dialer ack timeout: the dialer's wait for the handler's `remoteCloseWrite`
cannot use idle detection (handler writes nothing back), so it uses a flat
`ackTimeoutMs` deadline. The handler closes its write side promptly once
`onReceive` has durably recorded the work.

Defaults: `idleTimeoutMs = 10_000`, `ackTimeoutMs = 15_000`. All overridable via
options.

`eventPromise(target, type, signal)` helper (utils.ts) encapsulates the
listener bookkeeping (resolve on event, reject on abort, both listeners removed
on settle via an AbortController token). Replaces the hand-rolled promise in the
dialer's `remoteCloseWrite` wait, which currently leaks an abort listener and
rejects with `undefined`.

### 4. secp256k1 verify (challenge.ts / handler.ts)

`createSign` keeps producing 64-byte compact sigs (uniform wire width with
Ed25519). Add `verifyChallenge(publicKey, challenge, sig, options)`: for
secp256k1, convert compact -> DER (`secp.Signature.fromBytes(sig, "compact")
.toBytes("der")`) then `publicKey.verify`; for Ed25519, `publicKey.verify`
directly. The handler calls `verifyChallenge` instead of `publicKey.verify`.

### 5. `allow` required (handler.ts)

Promote from `options.allow?` to a required positional parameter:
`createZzzyncHandler(handlerPeerId, importer, allow, onReceive, options?)`.
Remove the `?? true` fail-open. The package docs example shows implementing
`allow.multihash` (gate which keys may push) and `allow.record` (gate each
record before the CAR is imported).

### 6. readIpnsMultihash explicit parse (handler.ts)

Parse the identity multihash explicitly: read code varint (assert
`CODEC_IDENTITY`), read length varint (assert `<= MAX_IPNS_KEY_BYTES`), read the
digest. Drop `validateIpnsCode` and the dead `CODEC_SHA2_256` branch. The IPNS
key is an identity multihash (raw embedded pubkey, not a content hash); content
blocks stay sha256-only via `getHasher`.

### 7. Dependency + types (interface.ts, package.json)

- Add `interface PushInput { record: IPNSRecord; publicKey: PublicKey }`
  (`IPNSRecord` from `ipns`, `PublicKey` from `@libp2p/interface`). The dialer
  takes `PushInput` instead of `IPNSPublishResult`.
- Remove `@tabcat/helia-ipns` from dependencies.
- Add `@ipld/dag-cbor` to dependencies (for `getCodec`).
- The docs example keeps `@helia/ipns` as a companion the consumer installs (not
  a zzzync dep); `PushInput` is structural so its publish result fits.

### 8. Constants (constants.ts)

```
MAX_IPNS_RECORD_SIZE   = 10 * 1024          // IPNS spec record cap
MAX_IPNS_KEY_BYTES     = 64                  // identity-wrapped key
DEFAULT_MAX_CAR_BYTES  = 5 * 1024 * 1024
MAX_BLOCK_BYTES        = 2 * 1024 * 1024
DEFAULT_MAX_BLOCK_COUNT= 10_000
DEFAULT_IDLE_TIMEOUT_MS= 10_000
DEFAULT_ACK_TIMEOUT_MS = 15_000
CODEC_DAG_CBOR         = 0x71
```
Bound `recordLength` to `MAX_IPNS_RECORD_SIZE` before reading the record.

### 9. maxInboundStreams (handler.ts)

`registerZzzyncHandler` defaults `maxInboundStreams` to 5 (per connection per
protocol), overridable via `StreamHandlerOptions`.

### 10. engines + CI

`package.json` `engines.node = ">=24"`. Bump `ci.yml`, `pages.yml`,
`publish.yml` to Node 24.

## Test plan (test-first for the security bugs)

Reproducing/failing first, then fix:
- CAR incomplete DAG: root links a child, deliver only the root -> reject.
- CAR codec downgrade: dag-pb link delivered as a raw block -> reject.
- CAR diamond: shared child delivered once, valid -> accept (no false reject).
- CAR duplicate / unreferenced / wrong-root / oversized-block / too-many-blocks
  / over-byte-cap -> reject.
- secp256k1 end-to-end handshake -> accept (currently fails).
- Idle timeout: a stalled read aborts after `idleTimeoutMs`.
- Dialer ack timeout: handler never closes -> dialer rejects after `ackTimeoutMs`.
- `allow` required: `allow.multihash`/`allow.record` returning false -> abort,
  `onReceive` not called.
- recordLength over `MAX_IPNS_RECORD_SIZE` -> reject before read.
- readIpnsMultihash: over `MAX_IPNS_KEY_BYTES` -> reject.

Plus updating existing tests for the new `createZzzyncHandler` signature and the
`PushInput` dialer type.

## Implementation order

1. constants.ts + interface.ts (PushInput) + package.json deps/engines.
2. utils.ts (eventPromise, getCodec dag-cbor, parsedRecordValue /ipfs/, idle
   wrapper).
3. challenge.ts (verifyChallenge).
4. handler.ts (readIpnsMultihash, record bound, readCarFile two-set, allow
   param, timeouts, verifyChallenge, maxInboundStreams).
5. dialer.ts (PushInput, eventPromise + ack timeout, idle reads).
6. index.ts docs example (allow + @helia/ipns companion).
7. workflows -> Node 24.
8. tests (reproducing-first for the bugs), then green CI-equiv.
