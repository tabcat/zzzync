import * as dagCbor from "@ipld/dag-cbor";
import * as dagPb from "@ipld/dag-pb";
import { generateKeyPair } from "@libp2p/crypto/keys";
import type { Stream } from "@libp2p/interface";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { CODEC_DAG_PB, IPFS_PREFIX } from "../src/constants.ts";
import {
  contenthash,
  getCodec,
  getHasher,
  parsedRecordValue,
  publicKeyAsIpnsMultihash,
  streamSignal,
} from "../src/utils.ts";

let dagPbCidStr: string;
let rawCidStr: string;
let ed25519Key: Awaited<ReturnType<typeof generateKeyPair>>;
let secp256k1Key: Awaited<ReturnType<typeof generateKeyPair>>;

beforeAll(async () => {
  const digest = await sha256.digest(new Uint8Array(10));
  dagPbCidStr = IPFS_PREFIX + CID.create(1, CODEC_DAG_PB, digest).toString();
  rawCidStr = IPFS_PREFIX + CID.create(1, 0x55, digest).toString();
  ed25519Key = await generateKeyPair("Ed25519");
  secp256k1Key = await generateKeyPair("secp256k1");
});

describe("parsedRecordValue", () => {
  it("returns a CID for a valid dag-pb value", () => {
    const cid = parsedRecordValue(dagPbCidStr);
    expect(cid).not.toBeNull();
    expect(cid!.code).toBe(CODEC_DAG_PB);
  });

  it("returns a CID for a valid raw value", () => {
    const cid = parsedRecordValue(rawCidStr);
    expect(cid).not.toBeNull();
    expect(cid!.code).toBe(0x55);
  });

  it("returns null for an invalid string", () => {
    expect(parsedRecordValue("not-a-cid")).toBeNull();
  });

  it("returns a CID for a valid dag-cbor value", async () => {
    const digest = await sha256.digest(new Uint8Array(10));
    const cborCid = CID.create(1, 0x71, digest);
    const cid = parsedRecordValue(IPFS_PREFIX + cborCid.toString());
    expect(cid).not.toBeNull();
    expect(cid!.code).toBe(0x71);
  });

  it("returns null for a value without the /ipfs/ prefix", () => {
    const cidStr = dagPbCidStr.slice(IPFS_PREFIX.length);
    expect(parsedRecordValue("/ipns/" + cidStr)).toBeNull();
  });
});

describe("getCodec", () => {
  it("returns the dag-pb codec for code 0x70", () => {
    expect(getCodec(CODEC_DAG_PB)).toBe(dagPb);
  });

  it("returns the dag-cbor codec for code 0x71", () => {
    expect(getCodec(0x71)).toBe(dagCbor);
  });

  it("returns the raw codec for code 0x55", () => {
    expect(getCodec(0x55)).toBe(raw);
  });

  it("throws for an unsupported codec", () => {
    expect(() => getCodec(0x99)).toThrow("Unsupported codec.");
  });
});

describe("getHasher", () => {
  it("returns sha256 for code 0x12", () => {
    expect(getHasher(sha256.code)).toBe(sha256);
  });

  it("throws for an unsupported hash code", () => {
    expect(() => getHasher(999)).toThrow("Unsupported hash code.");
  });
});

describe("publicKeyAsIpnsMultihash", () => {
  it("returns a multihash for an Ed25519 key", () => {
    expect(publicKeyAsIpnsMultihash(ed25519Key.publicKey)).not.toBeNull();
  });

  it("returns a multihash for a secp256k1 key", () => {
    expect(publicKeyAsIpnsMultihash(secp256k1Key.publicKey)).not.toBeNull();
  });
});

describe("contenthash", () => {
  it("returns an /ipns/ prefixed string", () => {
    const hash = contenthash(ed25519Key.publicKey);
    expect(hash.startsWith("/ipns/")).toBe(true);
  });

  it("is deterministic for the same key", () => {
    expect(contenthash(ed25519Key.publicKey)).toBe(
      contenthash(ed25519Key.publicKey),
    );
  });

  it("differs between keys", () => {
    expect(contenthash(ed25519Key.publicKey)).not.toBe(
      contenthash(secp256k1Key.publicKey),
    );
  });
});

describe("streamSignal", () => {
  // pure timer logic over a synchronous mock, so fake timers make every window
  // boundary exact instead of racing the scheduler
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const tick = async (ms: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(ms);
  };

  // minimal stand-in exposing only the event surface streamSignal touches
  function mockStream() {
    const listeners: Record<string, Set<(ev: unknown) => void>> = {};
    return {
      addEventListener(type: string, handler: (ev: unknown) => void): void {
        (listeners[type] ??= new Set()).add(handler);
      },
      removeEventListener(type: string, handler: (ev: unknown) => void): void {
        listeners[type]?.delete(handler);
      },
      dispatch(type: string, ev: unknown = {}): void {
        listeners[type]?.forEach((handler) => handler(ev));
      },
    };
  }

  /** Dispatch a message carrying `bytes` bytes, as the real stream does. */
  function send(stream: ReturnType<typeof mockStream>, bytes: number): void {
    stream.dispatch("message", { data: new Uint8Array(bytes) });
  }

  // every knob is required now, so `base` is a complete no-floor config
  const base = {
    idleTimeoutMs: 10_000,
    handshakeTimeoutMs: 10_000,
    maxStreamMs: 10_000,
    minBytesPerSecond: 0,
    rateWindowMs: 100,
  };
  // 1000 B/s over 100ms windows = 100 bytes required per window
  const floor = { minBytesPerSecond: 1000, rateWindowMs: 100 };

  it("aborts on the backstop deadline even while messages reset the idle timer", async () => {
    const stream = mockStream();
    const { signal, clear } = streamSignal(stream as unknown as Stream, {
      ...base,
      maxStreamMs: 500,
    });
    try {
      for (let i = 0; i < 10; i++) {
        send(stream, 1);
        await tick(60);
      }
      expect(signal.aborted).toBe(true);
      expect((signal.reason as Error | undefined)?.message).toContain(
        "stream deadline",
      );
    } finally {
      clear();
    }
  });

  it("aborts a handshake that outlives its own deadline", async () => {
    const stream = mockStream();
    const { signal, clear } = streamSignal(stream as unknown as Stream, {
      ...base,
      handshakeTimeoutMs: 300,
    });
    try {
      await tick(400);
      expect(signal.aborted).toBe(true);
      expect((signal.reason as Error | undefined)?.message).toContain(
        "handshake",
      );
    } finally {
      clear();
    }
  });

  it("beginTransfer retires the handshake deadline", async () => {
    const stream = mockStream();
    const { signal, beginTransfer, clear } = streamSignal(
      stream as unknown as Stream,
      { ...base, handshakeTimeoutMs: 300 },
    );
    try {
      beginTransfer();
      await tick(400);
      expect(signal.aborted).toBe(false);
    } finally {
      clear();
    }
  });

  it("keeps the idle timer running through the transfer phase", async () => {
    const stream = mockStream();
    // no floor: the idle timer is then the only bound on the transfer phase
    const { signal, beginTransfer, clear } = streamSignal(
      stream as unknown as Stream,
      { ...base, idleTimeoutMs: 200 },
    );
    try {
      beginTransfer();
      await tick(300);
      expect(signal.aborted).toBe(true);
      expect((signal.reason as Error | undefined)?.message).toContain("idle");
    } finally {
      clear();
    }
  });

  it("aborts a transfer whose throughput stays under the floor", async () => {
    const stream = mockStream();
    const { signal, beginTransfer, clear } = streamSignal(
      stream as unknown as Stream,
      { ...base, ...floor },
    );
    try {
      beginTransfer();
      // 20 bytes per window against 100 required: the drip this exists to catch
      for (let i = 0; i < 4; i++) {
        send(stream, 20);
        await tick(100);
      }
      expect(signal.aborted).toBe(true);
      expect((signal.reason as Error | undefined)?.message).toContain(
        "throughput",
      );
    } finally {
      clear();
    }
  });

  it("leaves a transfer that meets the floor alone", async () => {
    const stream = mockStream();
    const { signal, beginTransfer, clear } = streamSignal(
      stream as unknown as Stream,
      { ...base, ...floor },
    );
    try {
      beginTransfer();
      for (let i = 0; i < 6; i++) {
        send(stream, 500);
        await tick(100);
      }
      expect(signal.aborted).toBe(false);
    } finally {
      clear();
    }
  });

  it("requires the under-floor windows to be consecutive, not cumulative", async () => {
    const stream = mockStream();
    const { signal, beginTransfer, clear } = streamSignal(
      stream as unknown as Stream,
      { ...base, ...floor },
    );
    try {
      beginTransfer();
      // starve, recover, starve: a healthy transfer with two separated blips
      // must survive, or the count is cumulative rather than consecutive
      await tick(100);
      send(stream, 500);
      await tick(100);
      await tick(100);
      expect(signal.aborted).toBe(false);
      // and a third window with no recovery is the one that ends it
      await tick(100);
      expect(signal.aborted).toBe(true);
    } finally {
      clear();
    }
  });

  it("retires the floor once the remote closes its write side", async () => {
    const stream = mockStream();
    const { signal, beginTransfer, clear } = streamSignal(
      stream as unknown as Stream,
      { ...base, ...floor },
    );
    try {
      // the production ordering: transfer begins, the dialer sends its CAR and
      // closes write, then the handler's own import and onReceive run on with
      // no further bytes owed and must not be held to the floor
      beginTransfer();
      send(stream, 500);
      stream.dispatch("remoteCloseWrite");
      await tick(1000);
      expect(signal.aborted).toBe(false);
    } finally {
      clear();
    }
  });

  it("does not arm the floor after the remote closed its write side", async () => {
    const stream = mockStream();
    const { signal, beginTransfer, clear } = streamSignal(
      stream as unknown as Stream,
      { ...base, ...floor },
    );
    try {
      // the reverse ordering, reachable when a small CAR and its FIN land while
      // the handler is still verifying signatures
      stream.dispatch("remoteCloseWrite");
      beginTransfer();
      await tick(1000);
      expect(signal.aborted).toBe(false);
    } finally {
      clear();
    }
  });

  it("does not arm the floor after clear", async () => {
    const stream = mockStream();
    const { signal, beginTransfer, clear } = streamSignal(
      stream as unknown as Stream,
      { ...base, ...floor },
    );
    clear();
    beginTransfer();
    await tick(1000);
    // clear() has already detached the listeners, so a timer armed here would
    // be unstoppable
    expect(signal.aborted).toBe(false);
  });

  it("ignores a second beginTransfer instead of orphaning the first timer", async () => {
    const stream = mockStream();
    const { signal, beginTransfer, clear } = streamSignal(
      stream as unknown as Stream,
      { ...base, ...floor },
    );
    beginTransfer();
    beginTransfer();
    // if the second call armed its own interval, clear() would only stop one of
    // them and the survivor would abort with nothing arriving
    clear();
    await tick(1000);
    expect(signal.aborted).toBe(false);
  });

  it("applies no floor when minBytesPerSecond is 0", async () => {
    const stream = mockStream();
    const { signal, beginTransfer, clear } = streamSignal(
      stream as unknown as Stream,
      base,
    );
    try {
      beginTransfer();
      for (let i = 0; i < 6; i++) {
        send(stream, 1);
        await tick(100);
      }
      expect(signal.aborted).toBe(false);
    } finally {
      clear();
    }
  });

  it("rejects a rate window that would disable the floor it was given", () => {
    const stream = mockStream();
    expect(() =>
      streamSignal(stream as unknown as Stream, {
        ...base,
        minBytesPerSecond: 1000,
        rateWindowMs: 0,
      })
    )
      .toThrow(/rateWindowMs/);
  });

  it("rejects a deadline past the timer range instead of firing at once", () => {
    const stream = mockStream();
    // setTimeout truncates past 2^31-1 ms and fires immediately, turning a
    // generous backstop into an instant abort
    for (
      const field of ["idleTimeoutMs", "handshakeTimeoutMs", "maxStreamMs"]
    ) {
      expect(() =>
        streamSignal(stream as unknown as Stream, {
          ...base,
          [field]: 30 * 24 * 60 * 60 * 1000,
        })
      )
        .toThrow(new RegExp(field));
    }
  });
});
