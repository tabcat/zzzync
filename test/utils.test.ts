import * as dagCbor from "@ipld/dag-cbor";
import * as dagPb from "@ipld/dag-pb";
import { generateKeyPair } from "@libp2p/crypto/keys";
import type { Stream } from "@libp2p/interface";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { beforeAll, describe, expect, it } from "vitest";
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
  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms));

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

  const base = {
    idleTimeoutMs: 1000,
    handshakeTimeoutMs: 1000,
    maxStreamMs: 1000,
  };

  it("aborts on the total deadline even while messages reset the idle timer", async () => {
    const stream = mockStream();
    const { signal, clear } = streamSignal(stream as unknown as Stream, {
      ...base,
      maxStreamMs: 100,
    });
    const trickle = setInterval(() => send(stream, 1), 20);
    try {
      await delay(180);
      expect(signal.aborted).toBe(true);
      expect((signal.reason as Error | undefined)?.message).toContain(
        "deadline",
      );
    } finally {
      clearInterval(trickle);
      clear();
    }
  });

  it("aborts a handshake that outlives its own deadline", async () => {
    const stream = mockStream();
    // the handshake is bounded data, so it gets a wall-clock cap of its own,
    // well inside the total deadline
    const { signal, clear } = streamSignal(stream as unknown as Stream, {
      ...base,
      handshakeTimeoutMs: 60,
      maxStreamMs: 10_000,
    });
    const trickle = setInterval(() => send(stream, 1), 15);
    try {
      await delay(140);
      expect(signal.aborted).toBe(true);
      expect((signal.reason as Error | undefined)?.message).toContain(
        "handshake",
      );
    } finally {
      clearInterval(trickle);
      clear();
    }
  });

  it("beginTransfer retires the handshake deadline", async () => {
    const stream = mockStream();
    const { signal, beginTransfer, clear } = streamSignal(
      stream as unknown as Stream,
      { ...base, handshakeTimeoutMs: 60, maxStreamMs: 10_000 },
    );
    const trickle = setInterval(() => send(stream, 1), 15);
    try {
      beginTransfer();
      await delay(140);
      expect(signal.aborted).toBe(false);
    } finally {
      clearInterval(trickle);
      clear();
    }
  });

  it("aborts a transfer whose throughput stays under the floor", async () => {
    const stream = mockStream();
    // 1000 B/s over 50ms windows = 50 bytes required per window
    const { signal, beginTransfer, clear } = streamSignal(
      stream as unknown as Stream,
      {
        ...base,
        maxStreamMs: 10_000,
        minBytesPerSecond: 1000,
        rateWindowMs: 50,
      },
    );
    // enough to hold the idle timer open, nowhere near the floor: the drip
    // this whole mechanism exists to catch
    const trickle = setInterval(() => send(stream, 2), 20);
    try {
      beginTransfer();
      await delay(300);
      expect(signal.aborted).toBe(true);
      expect((signal.reason as Error | undefined)?.message).toContain(
        "throughput",
      );
    } finally {
      clearInterval(trickle);
      clear();
    }
  });

  it("leaves a transfer that meets the floor alone", async () => {
    const stream = mockStream();
    const { signal, beginTransfer, clear } = streamSignal(
      stream as unknown as Stream,
      {
        ...base,
        maxStreamMs: 10_000,
        minBytesPerSecond: 1000,
        rateWindowMs: 50,
      },
    );
    const trickle = setInterval(() => send(stream, 200), 20);
    try {
      beginTransfer();
      await delay(300);
      expect(signal.aborted).toBe(false);
    } finally {
      clearInterval(trickle);
      clear();
    }
  });

  it("tolerates a single under-floor window", async () => {
    const stream = mockStream();
    const { signal, beginTransfer, clear } = streamSignal(
      stream as unknown as Stream,
      {
        ...base,
        maxStreamMs: 10_000,
        minBytesPerSecond: 1000,
        rateWindowMs: 50,
      },
    );
    try {
      beginTransfer();
      // one starved window, then back above the floor: congestion should not
      // look like an attack
      await delay(60);
      send(stream, 500);
      await delay(60);
      expect(signal.aborted).toBe(false);
    } finally {
      clear();
    }
  });

  it("does not arm the floor after the remote closed its write side", async () => {
    const stream = mockStream();
    const { signal, beginTransfer, clear } = streamSignal(
      stream as unknown as Stream,
      {
        ...base,
        maxStreamMs: 10_000,
        minBytesPerSecond: 1000,
        rateWindowMs: 30,
      },
    );
    try {
      // the dialer writes record, CAR and closeWrite back to back, so on a fast
      // local dial this can land before the handler reaches beginTransfer. The
      // buffered tail owes no further bytes and must not be held to the floor.
      stream.dispatch("remoteCloseWrite");
      beginTransfer();
      await delay(150);
      expect(signal.aborted).toBe(false);
    } finally {
      clear();
    }
  });

  it("does not arm the floor after clear", async () => {
    const stream = mockStream();
    const { signal, beginTransfer, clear } = streamSignal(
      stream as unknown as Stream,
      {
        ...base,
        maxStreamMs: 10_000,
        minBytesPerSecond: 1000,
        rateWindowMs: 30,
      },
    );
    clear();
    beginTransfer();
    await delay(150);
    // clear() has already detached the listeners, so a timer armed here would
    // be unstoppable
    expect(signal.aborted).toBe(false);
  });

  it("ignores a second beginTransfer", async () => {
    const stream = mockStream();
    const { signal, beginTransfer, clear } = streamSignal(
      stream as unknown as Stream,
      {
        ...base,
        maxStreamMs: 10_000,
        minBytesPerSecond: 1000,
        rateWindowMs: 40,
      },
    );
    const trickle = setInterval(() => send(stream, 200), 15);
    try {
      beginTransfer();
      await delay(50);
      beginTransfer();
      await delay(150);
      expect(signal.aborted).toBe(false);
    } finally {
      clearInterval(trickle);
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
    expect(() =>
      streamSignal(stream as unknown as Stream, {
        ...base,
        maxStreamMs: 30 * 24 * 60 * 60 * 1000,
      })
    )
      .toThrow(/maxStreamMs/);
  });

  it("applies no floor when minBytesPerSecond is unset", async () => {
    const stream = mockStream();
    const { signal, beginTransfer, clear } = streamSignal(
      stream as unknown as Stream,
      { ...base, maxStreamMs: 10_000, rateWindowMs: 50 },
    );
    const trickle = setInterval(() => send(stream, 1), 20);
    try {
      beginTransfer();
      await delay(300);
      expect(signal.aborted).toBe(false);
    } finally {
      clearInterval(trickle);
      clear();
    }
  });
});
