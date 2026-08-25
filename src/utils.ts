import * as dagCbor from "@ipld/dag-cbor";
import * as dagPb from "@ipld/dag-pb";
import type {
  EventHandler,
  Logger,
  PublicKey,
  Stream,
  StreamCloseEvent,
  StreamMessageEvent,
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

/** Consecutive under-floor windows tolerated before aborting, so a single congested window is not read as an attack. */
const STARVED_WINDOWS_BEFORE_ABORT = 2;

/** Past this, setTimeout truncates and fires immediately, turning a long deadline into an instant abort. */
const MAX_TIMER_MS = 2 ** 31 - 1;

function checkDuration(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new TypeError(
      `${name} must be a positive integer no greater than ${MAX_TIMER_MS}, got ${value}`,
    );
  }
}

/**
 * Run `op` under a deadline that does not depend on `op` cooperating.
 *
 * `withDeadline` hands a signal in and awaits the result, so it bounds only
 * code that honours the signal. That is right for zzzync's own reads and
 * writes and wrong for an application callback, where forgetting to thread the
 * signal is an ordinary mistake and the cost is a handler that never returns.
 * This races instead, so the deadline holds either way.
 *
 * `op` still receives a signal and should honour it, since a cooperative abort
 * stops the work. Racing only bounds the caller: a losing `op` keeps running,
 * and its result is discarded.
 */
export async function raceDeadline<T>(
  op: (signal: AbortSignal) => T | Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  const deadline = deadlineSignal(signal, timeoutMs);
  const timedOut = Symbol("timedOut");

  // settle `op` into a value either way, so the losing branch of the race can
  // never surface as an unhandled rejection
  const work: Promise<{ value: T; } | { error: unknown; }> = (async () => {
    try {
      return { value: await op(deadline.signal) };
    } catch (error) {
      return { error };
    }
  })();

  try {
    const outcome = await Promise.race([
      work,
      new Promise<typeof timedOut>((resolve) => {
        if (deadline.signal.aborted) {
          resolve(timedOut);
          return;
        }
        deadline.signal.addEventListener("abort", () => resolve(timedOut), {
          once: true,
        });
      }),
    ]);

    if (outcome === timedOut) {
      throw new Error(message);
    }
    if ("error" in outcome) {
      throw outcome.error;
    }
    return outcome.value;
  } finally {
    deadline.clear();
  }
}

export interface StreamSignal {
  /** Aborts on idle, handshake deadline, throughput floor, backstop deadline, or stream error-close. */
  signal: AbortSignal;
  /**
   * Leave the handshake behind: retire its wall-clock deadline and start
   * enforcing the throughput floor, if one was configured.
   */
  beginTransfer: () => void;
  /** Detach listeners and cancel every timer; call in `finally`. */
  clear: () => void;
}

export interface StreamSignalOptions {
  /** Abort if no bytes arrive at all for this long. Applies to both phases. */
  idleTimeoutMs: number;
  /** Wall-clock cap on the handshake, retired by `beginTransfer`. */
  handshakeTimeoutMs: number;
  /** Wall-clock backstop for the receive phase, not reset by activity. Cleared once the remote closes its write side. */
  maxStreamMs: number;
  /**
   * Bytes per second a transfer must sustain once `beginTransfer` is called.
   * `0` is how you ask for no floor at all.
   */
  minBytesPerSecond: number;
  /** Window the floor is sampled over. */
  rateWindowMs: number;
}

/**
 * Tie an AbortSignal to a handler stream's lifetime, in two phases.
 *
 * Throughout: abort if the stream closes with an error, if no `message`
 * arrives for `idleTimeoutMs`, or after `maxStreamMs` as an absolute backstop.
 *
 * The handshake carries bounded, latency-bound data, so it gets a wall-clock
 * cap (`handshakeTimeoutMs`). The CAR that follows is unbounded bulk transfer,
 * where a wall-clock cap cannot tell "slow" from "large", so `beginTransfer`
 * swaps that cap for a `minBytesPerSecond` floor. The floor is what stops a
 * dialer dripping one byte per idle window to hold a stream open indefinitely:
 * the idle timer resets on any byte, but the floor makes occupying a stream
 * cost bandwidth in proportion to how long it is held. Two consecutive
 * under-floor windows are required, so ordinary congestion is not an abort.
 *
 * Every timer stops once the remote closes its write side, so processing the
 * buffered tail is unbounded by all of them, including `maxStreamMs`: work after
 * that point, `onReceive` included, carries no deadline from here. The listeners
 * only manage timers and count bytes, never reading or consuming from the
 * stream, so they run alongside the byte stream's own handlers. Always call
 * `clear()` in a `finally`.
 */
export function streamSignal(
  stream: Stream,
  options: StreamSignalOptions,
): StreamSignal {
  const {
    idleTimeoutMs,
    handshakeTimeoutMs,
    maxStreamMs,
    minBytesPerSecond,
    rateWindowMs,
  } = options;

  // fail at construction rather than aborting a stream much later, or silently
  // never aborting one
  checkDuration("idleTimeoutMs", idleTimeoutMs);
  checkDuration("handshakeTimeoutMs", handshakeTimeoutMs);
  checkDuration("maxStreamMs", maxStreamMs);
  checkDuration("rateWindowMs", rateWindowMs);
  if (!Number.isFinite(minBytesPerSecond) || minBytesPerSecond < 0) {
    throw new TypeError(
      `minBytesPerSecond must be a non-negative finite number, got ${minBytesPerSecond}`,
    );
  }

  // handshake -> transfer -> stopped, one way. Guards beginTransfer against
  // reviving timers that stopTimers deliberately retired.
  let phase: "handshake" | "transfer" | "stopped" = "handshake";
  const controller = new AbortController();
  const onClose: EventHandler<StreamCloseEvent> = (event) => {
    if (event.error != null) {
      // pass the reason through: this is the only record of WHY a remote
      // stream died, and it is the forensic surface for untrusted peers
      controller.abort(event.error);
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

  // a backstop that is NOT reset by incoming messages. When a throughput floor
  // is configured it owns slow-drip, leaving this to stop a stream running
  // forever, generous enough not to cap transfer size by accident. With no
  // floor configured this is once again the only slow-drip bound.
  let deadline: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => controller.abort(new Error("stream deadline exceeded")),
    maxStreamMs,
  );

  let handshake: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => controller.abort(new Error("handshake deadline exceeded")),
    handshakeTimeoutMs,
  );

  let windowBytes = 0;
  let starvedWindows = 0;
  let rate: ReturnType<typeof setInterval> | undefined;

  const stopTimers = (): void => {
    phase = "stopped";
    if (timer != null) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (deadline != null) {
      clearTimeout(deadline);
      deadline = undefined;
    }
    if (handshake != null) {
      clearTimeout(handshake);
      handshake = undefined;
    }
    if (rate != null) {
      clearInterval(rate);
      rate = undefined;
    }
  };

  const beginTransfer = (): void => {
    if (phase !== "handshake") {
      return;
    }
    phase = "transfer";

    if (handshake != null) {
      clearTimeout(handshake);
      handshake = undefined;
    }

    // 0 asks for no floor; arming one would spin a timer that can never abort,
    // since windowBytes is never below 0
    if (minBytesPerSecond === 0) {
      return;
    }

    const required = (minBytesPerSecond * rateWindowMs) / 1000;
    windowBytes = 0;
    starvedWindows = 0;
    rate = setInterval(() => {
      starvedWindows = windowBytes < required ? starvedWindows + 1 : 0;
      windowBytes = 0;

      if (starvedWindows >= STARVED_WINDOWS_BEFORE_ABORT) {
        controller.abort(new Error("stream throughput below minimum"));
        if (rate != null) {
          clearInterval(rate);
          rate = undefined;
        }
      }
    }, rateWindowMs);
  };

  const onMessage: EventHandler<StreamMessageEvent> = (event) => {
    windowBytes += event.data.byteLength;
    resetIdle();
  };
  const onRemoteCloseWrite = stopTimers;

  stream.addEventListener("close", onClose);
  stream.addEventListener("message", onMessage);
  stream.addEventListener("remoteCloseWrite", onRemoteCloseWrite);
  resetIdle();

  return {
    signal: controller.signal,
    beginTransfer,
    clear: () => {
      stopTimers();
      stream.removeEventListener("close", onClose);
      stream.removeEventListener("message", onMessage);
      stream.removeEventListener("remoteCloseWrite", onRemoteCloseWrite);
    },
  };
}
