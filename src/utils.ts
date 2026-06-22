import * as dagCbor from "@ipld/dag-cbor";
import * as dagPb from "@ipld/dag-pb";
import type {
  AbortOptions,
  EventHandler,
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

export interface StreamSignal {
  /** Aborts when the stream errors-closes or `options.signal` aborts. */
  signal: AbortSignal;
  /** Detach the close listener and clear the combined signal; call in `finally`. */
  clear: () => void;
}

/**
 * Tie an AbortSignal to a stream's lifetime: it aborts if the stream closes with
 * an error, and also follows `options.signal`. Both the handler and dialer wrap
 * their stream work in this; always call `clear()` in a `finally`.
 */
export function streamSignal(
  stream: Stream,
  options: AbortOptions = {},
): StreamSignal {
  const controller = new AbortController();
  const onClose: EventHandler<StreamCloseEvent> = (event) => {
    if (event.error != null) {
      controller.abort();
    }
  };
  stream.addEventListener("close", onClose);
  const signal = anySignal([controller.signal, options.signal]);

  return {
    signal,
    clear: () => {
      signal.clear();
      stream.removeEventListener("close", onClose);
    },
  };
}
