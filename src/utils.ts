import * as dagCbor from "@ipld/dag-cbor";
import * as dagPb from "@ipld/dag-pb";
import type {
  EventHandler,
  Logger,
  PublicKey,
  Stream,
  StreamCloseEvent,
} from "@libp2p/interface";
import { anySignal } from "any-signal";
import type { BlockCodec, MultihashHasher } from "multiformats";
import { base36 } from "multiformats/bases/base36";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import {
  CODEC_DAG_CBOR,
  CODEC_DAG_PB,
  CODEC_RAW,
  type CODEC_SHA2_256,
  IPFS_PREFIX,
} from "./constants.ts";
import type { IpnsMultihash, UnixFsCID } from "./interface.ts";

export function parsedRecordValue(value: string): UnixFsCID | null {
  if (!value.startsWith(IPFS_PREFIX)) {
    return null;
  }
  try {
    const cid = CID.parse(value.substring(IPFS_PREFIX.length));
    getHasher(cid.multihash.code);
    if (
      cid.code === CODEC_DAG_PB || cid.code === CODEC_RAW || cid
          .code === CODEC_DAG_CBOR
    ) {
      return cid as UnixFsCID;
    }
  } catch {}
  return null;
}

export function getCodec(code: number): BlockCodec<number, unknown> {
  switch (code) {
    case dagPb.code:
      return dagPb;
    case dagCbor.code:
      return dagCbor;
    case raw.code:
      return raw;
    default:
      throw new Error("Unsupported codec.");
  }
}

export type SupportedHasherCodes = typeof CODEC_SHA2_256;

export function getHasher(code: number): MultihashHasher {
  switch (code) {
    case sha256.code:
      return sha256;
    default:
      throw new Error("Unsupported hash code.");
  }
}

export function publicKeyAsIpnsMultihash(
  publicKey: PublicKey,
): IpnsMultihash | null {
  if (publicKey.type === "Ed25519" || publicKey.type === "secp256k1") {
    return publicKey.toMultihash();
  }

  return null;
}

export function contenthash(publicKey: PublicKey): string {
  return `/ipns/${publicKey.toCID().toString(base36)}`;
}

/**
 * Resolve when `target` emits `type`; reject if `signal` aborts. Both listeners
 * are removed once the promise settles, so neither path leaks a listener.
 */
export function eventPromise<E extends string>(
  target: {
    addEventListener(type: E, listener: () => void): void;
    removeEventListener(type: E, listener: () => void): void;
  },
  type: E,
  signal: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    function cleanup(): void {
      target.removeEventListener(type, onEvent);
      signal.removeEventListener("abort", onAbort);
    }
    function onEvent(): void {
      cleanup();
      resolve();
    }
    function onAbort(): void {
      cleanup();
      reject(signal.reason ?? new Error("aborted"));
    }

    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    target.addEventListener(type, onEvent);
    signal.addEventListener("abort", onAbort);
  });
}

export interface DeadlineSignal {
  signal: AbortSignal;
  /** Cancel the timer and detach the combined signal; call in `finally`. */
  clear: () => void;
}

/**
 * A signal that aborts when `signal` aborts or after `timeoutMs`. Unlike
 * `AbortSignal.timeout`, the timer is cancellable: call `clear()` to cancel it
 * and detach the combined signal.
 */
export function deadlineSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): DeadlineSignal {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("deadline exceeded")),
    timeoutMs,
  );
  const combined = anySignal([signal, controller.signal]);
  return {
    signal: combined,
    clear: () => {
      clearTimeout(timer);
      combined.clear();
    },
  };
}

export interface DeadlineOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  log: Logger;
}

/**
 * Run `op` under a per-call deadline. Logs `done` on success and `error` on
 * failure, always rethrowing on failure.
 */
export async function withDeadline<T>(
  op: (deadline: AbortSignal) => Promise<T>,
  done: string,
  error: string,
  options: DeadlineOptions,
): Promise<T> {
  const deadline = deadlineSignal(options.signal, options.timeoutMs);
  try {
    const result = await op(deadline.signal);
    options.log(done);
    return result;
  } catch (e) {
    options.log.error(error);
    throw e;
  } finally {
    deadline.clear();
  }
}

export interface StreamSignal {
  /** Aborts on idle timeout or stream error-close. */
  signal: AbortSignal;
  /** Detach listeners and cancel the timer; call in `finally`. */
  clear: () => void;
}

/**
 * Tie an AbortSignal to a handler stream's lifetime. It aborts if the stream
 * closes with an error, if no `message` (incoming bytes) arrives for
 * `idleTimeoutMs`, or after a hard `maxStreamMs` wall-clock deadline. The idle
 * timer resets on each `message`; the deadline does not, so a slow-drip dialer
 * cannot keep resetting the idle timer to hold the stream open. Both timers stop
 * once the remote closes its write side (`remoteCloseWrite`), so processing the
 * already-buffered tail is not bounded by either. The listeners only manage the
 * timers, never reading or consuming data, so they run alongside the byte
 * stream's own handlers. Always call `clear()` in a `finally`.
 */
export function streamSignal(
  stream: Stream,
  idleTimeoutMs: number,
  maxStreamMs: number,
): StreamSignal {
  const controller = new AbortController();
  const onClose: EventHandler<StreamCloseEvent> = (event) => {
    if (event.error != null) {
      controller.abort();
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const resetIdle = (): void => {
    if (timer != null) {
      clearTimeout(timer);
    }
    timer = setTimeout(
      () => controller.abort(new Error("stream idle timeout")),
      idleTimeoutMs,
    );
  };

  // a single wall-clock deadline that is NOT reset by incoming messages, so a
  // slow-drip dialer cannot keep resetting the idle timer to hold the stream open
  let deadline: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => controller.abort(new Error("stream deadline exceeded")),
    maxStreamMs,
  );

  const stopTimers = (): void => {
    if (timer != null) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (deadline != null) {
      clearTimeout(deadline);
      deadline = undefined;
    }
  };

  const onMessage = resetIdle;
  const onRemoteCloseWrite = stopTimers;

  stream.addEventListener("close", onClose);
  stream.addEventListener("message", onMessage);
  stream.addEventListener("remoteCloseWrite", onRemoteCloseWrite);
  resetIdle();

  return {
    signal: controller.signal,
    clear: () => {
      stopTimers();
      stream.removeEventListener("close", onClose);
      stream.removeEventListener("message", onMessage);
      stream.removeEventListener("remoteCloseWrite", onRemoteCloseWrite);
    },
  };
}
