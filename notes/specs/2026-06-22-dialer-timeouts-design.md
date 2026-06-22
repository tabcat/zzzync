# zzzync dialer timeouts (idle/abort hardening, dialer half)

Date: 2026-06-22
Status: approved, implementing (dialer only; handler idle is a follow-up)

## Scope

Add timeout protection to the dialer half of the push protocol. This is the
deferred "Timeouts" piece from the CAR-reader hardening spec. The handler half (a
message-listener idle, stopped before `onReceive`) is a separate follow-up.

## Motivation

A stalled or non-reading handler can hang the dialer indefinitely:
- waiting on the handler's nonce during the handshake,
- blocked on a backpressured CAR write (handler stops reading, byteStream parks on
  `pEvent(stream, 'drain')`),
- waiting for the handler's `remoteCloseWrite` after the upload.

A handler that closes/errors already rejects a blocked write via byteStream's
`rejectionEvents: ['close']`; the remaining gap is the silent-stop-reading
handler. The session signal already carries error-close + the caller's signal;
this adds built-in deadlines so even a no-signal caller is covered.

## Design

### withDeadline helper (dialer.ts)

One helper runs an op under a per-call deadline and owns its logging. `timeoutMs`
is required (the dialer always sets one), so there is no conditional:

```ts
async function withDeadline<T>(
  op: (deadline: AbortSignal) => Promise<T>,
  done: string,
  error: string,
  options: { signal: AbortSignal; timeoutMs: number; log: Logger },
): Promise<T> {
  const deadline = anySignal([options.signal, AbortSignal.timeout(options.timeoutMs)]);
  try {
    const result = await op(deadline);
    options.log(done);
    return result;
  } catch (e) {
    options.log.error(error);
    throw e;
  } finally {
    deadline.clear();
  }
}
```

`deadline` = the session signal combined with a fresh `AbortSignal.timeout`. Each
call gets its own deadline (per-step / per-chunk). The done/error strings live in
the helper that calls `withDeadline`, so orchestrators stay clean.

### Phase helpers (absorb the trivial low-level read/write helpers)

- `writeKey(bs, mh, options)` -> `withDeadline`, "wrote ipns key".
- `readHandlerNonce(bs, options)` -> `withDeadline`, "read handler nonce".
- `respondToChallenge(bs, handlerPeerId, dialerIpns, handlerNonce, sign, options)`
  -> `withDeadline`, sign + write response, "wrote response to challenge".
- `authenticateToHandler(...)` = `writeKey` -> `readHandlerNonce` ->
  `respondToChallenge`, each with `timeoutMs: handshakeStepTimeoutMs`.
- `writeCarFile` = write record + per-chunk CAR writes, each chunk under
  `withDeadline(writeTimeoutMs)`; one "wrote car file" phase log.
- `awaitHandlerClose(stream, options)` = `withDeadline(ackTimeoutMs)` around
  `eventPromise(stream, "remoteCloseWrite", deadline)`.

The old exported low-level helpers (`writeIpnsMultihash`, `completeChallenge`,
`writeIpnsRecord`, `readNonce`, `writeChallengeResponse`) are absorbed into the
phase helpers; the public surface becomes the phase helpers + `zzzync`/
`dialZzzync`.

### DialOptions

```ts
interface DialOptions extends AbortOptions {
  handshakeStepTimeoutMs?: number; // per handshake step (key/nonce/response). default 5_000
  writeTimeoutMs?: number;         // per CAR chunk (and the record write). default 30_000
  ackTimeoutMs?: number;           // wait for the handler to close. default 15_000
}
```

Orchestrator applies the defaults (`options.x ?? DEFAULT_X`) before passing a
concrete `timeoutMs` into the helpers.

### eventPromise (re-added, utils.ts)

The leak-fixed wait helper for the ack: resolve on the event, reject on signal
abort, remove both listeners on settle. Used by `awaitHandlerClose`.

### Orchestrator

`zzzync` stays a clean sequence: `streamSignal` (error-close + caller) -> `bs` ->
`authenticateToHandler` -> write record + `writeCarFile` -> `stream.close` ->
`awaitHandlerClose`, with the outer `finally { clear() }`. All original per-step
logs are preserved (now inside the helpers); the ack wait gains a done/error log.

## Test plan

Rework the dialer half of `handshake.test.ts` to drive `authenticateToHandler`
(the low-level helpers are gone). Add:
- handshake step timeout: handler never sends the nonce -> dialer rejects after
  `handshakeStepTimeoutMs`.
- ack timeout: handler never closes -> dialer rejects after `ackTimeoutMs`.
- write timeout: a non-reading handler -> a CAR chunk write rejects after
  `writeTimeoutMs`.
Keep the happy-path, wrong-key, and secp256k1 handshake tests passing (updated for
the new helper).

## Out of scope

- Handler idle (message-listener + `stopIdle` before `onReceive`): follow-up.
- A "receiver consumed" muxer event: upstream libp2p/yamux, not here.
