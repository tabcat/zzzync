import { type Car } from "@helia/car";
import { CarBlockIterator } from "@ipld/car/iterator";
import { publicKeyFromMultihash } from "@libp2p/crypto/keys";
import type {
  AbortOptions,
  Connection,
  Libp2p,
  Logger,
  PeerId,
  Stream,
  StreamHandler,
  StreamHandlerOptions,
} from "@libp2p/interface";
import { logger } from "@libp2p/logger";
import { type ByteStream, byteStream } from "@libp2p/utils";
import {
  type IPNSRecord,
  multihashToIPNSRoutingKey,
  unmarshalIPNSRecord,
} from "ipns";
import { ipnsValidator } from "ipns/validator";
import { base32 } from "multiformats/bases/base32";
import { create } from "multiformats/block";
import type { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import * as varint from "uint8-varint";
import {
  buildChallenge,
  generateNonce,
  SupportedPrivateKey,
  verifyChallenge,
} from "./challenge.ts";
import {
  CODEC_DAG_CBOR,
  CODEC_DAG_PB,
  CODEC_IDENTITY,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_BLOCK_COUNT,
  DEFAULT_MAX_CAR_BYTES,
  MAX_BLOCK_BYTES,
  MAX_IPNS_KEY_BYTES,
  MAX_IPNS_RECORD_SIZE,
  ZZZYNC,
  ZZZYNC_PUSH_PROTOCOL_ID,
} from "./constants.ts";
import type { IpnsMultihash, Libp2pKey, UnixFsCID } from "./interface.ts";
import {
  contenthash,
  getCodec,
  getHasher,
  parsedRecordValue,
  streamSignal,
} from "./utils.ts";

export const HANDLER_NAMESPACE = `${ZZZYNC}:handler`;
const l = logger(HANDLER_NAMESPACE);

async function readByte(
  bs: ByteStream<Stream>,
  options: AbortOptions = {},
): Promise<number> {
  const [byte] = await bs.read({ bytes: 1, signal: options.signal });

  // biome-ignore lint/style/noNonNullAssertion: bs.read would throw if it couldn't return a byte
  return byte![0]!; // byte stream will return 1 byte or throw
}

export async function readVarint(
  bs: ByteStream<Stream>,
  options: AbortOptions = {},
): Promise<number> {
  let byte = await readByte(bs, options);
  const varintBytes: number[] = [byte];

  while (byte & 0x80) {
    byte = await readByte(bs, options);
    varintBytes.push(byte);

    // max varint size is 10 bytes
    if (varintBytes.length === 10) {
      break;
    }
  }

  return varint.decode(new Uint8Array(varintBytes));
}

export async function readIpnsMultihash(
  bs: ByteStream<Stream>,
  log: Logger,
  options: AbortOptions = {},
): Promise<IpnsMultihash> {
  try {
    // IPNS keys are identity multihashes: <code 0x00><length><digest>
    const code = await readVarint(bs, options);
    if (code !== CODEC_IDENTITY) {
      throw new Error("Expected identity multihash");
    }

    const length = await readVarint(bs, options);
    if (length > MAX_IPNS_KEY_BYTES) {
      throw new Error("IPNS key exceeds max byte length");
    }

    const digest = await bs.read({ bytes: length, signal: options.signal });
    const name = Digest.create(CODEC_IDENTITY, digest.subarray());
    log("read ipns multihash %t", name.bytes);
    return name;
  } catch (e) {
    log.error("failed while reading ipns key from stream");
    throw e;
  }
}

export async function writeChallengeNonce(
  bs: ByteStream<Stream>,
  handlerNonce: Uint8Array,
  options: AbortOptions = {},
): Promise<void> {
  await bs.write(handlerNonce, options);
}

export async function readChallengeResponse(
  bs: ByteStream<Stream>,
  options: AbortOptions = {},
): Promise<[Uint8Array, Uint8Array]> {
  const dialerNonceAndSig = await bs.read({
    bytes: 32 + 64,
    signal: options.signal,
  });

  return [dialerNonceAndSig.subarray(0, 32), dialerNonceAndSig.subarray(32)];
}

export async function readIpnsRecord(
  bs: ByteStream<Stream>,
  ipnsMultihash: IpnsMultihash,
  log: Logger,
  options: AbortOptions = {},
): Promise<IPNSRecord> {
  try {
    const recordLength = await readVarint(bs, options);
    if (recordLength > MAX_IPNS_RECORD_SIZE) {
      throw new Error("IPNS record exceeds max size");
    }

    const marshalledRecord = (await bs
      .read({ bytes: recordLength, signal: options.signal }))
      .subarray();

    await ipnsValidator(
      multihashToIPNSRoutingKey(ipnsMultihash),
      marshalledRecord,
    );

    const record = unmarshalIPNSRecord(marshalledRecord);
    log("read ipns record with value %s", record.value);
    return record;
  } catch (e) {
    log.error("failed while reading ipns record from stream");
    throw e;
  }
}

export interface ReadCarFileOptions extends AbortOptions {
  maxByteLength?: number;
  maxBlockCount?: number;
}

/** Canonical (v1, base32) CID key so codec differences are preserved. */
const cidKey = (cid: CID): string => cid.toV1().toString(base32);

export async function readCarFile(
  bs: ByteStream<Stream>,
  importer: Pick<Car, "import">,
  expectedRoot: UnixFsCID,
  log: Logger,
  options: ReadCarFileOptions = {},
): Promise<void> {
  const maxByteLength = options.maxByteLength ?? DEFAULT_MAX_CAR_BYTES;
  const maxBlockCount = options.maxBlockCount ?? DEFAULT_MAX_BLOCK_COUNT;

  const blocks = async function*() {
    // Bound the raw bytes fed to the CAR decoder. @ipld/car buffers a whole
    // section (a block or the header) of its declared length before yielding it,
    // and the per-block/total caps below only see a block once it is fully
    // materialized; without this budget an attacker-declared length would be
    // buffered in full first (a memory DoS). Counting raw bytes also makes
    // maxByteLength cover CAR framing, not just decoded block payload.
    let pulled = 0;
    const car = await CarBlockIterator.fromIterable(
      (async function*(): AsyncIterable<Uint8Array> {
        while (true) {
          const byteList = await bs.read({ signal: options.signal });

          if (byteList == null) break;

          pulled += byteList.byteLength;
          if (pulled > maxByteLength) {
            throw new Error("CAR file exceeded max byte length");
          }

          yield* byteList;
        }
      })(),
    );

    const [root] = await car.getRoots();

    if (root == null || !root.equals(expectedRoot)) {
      throw new Error("ERR_UNEXPECTED_ROOT");
    }

    // Deduped CAR: `wanted` holds CIDs referenced but not yet received, `received`
    // holds CIDs already imported. A block must already be wanted (else it is
    // unreferenced or a duplicate); after importing it, its links become wanted
    // unless already received/wanted. At the end `wanted` must be empty, which
    // proves the full DAG was delivered. Keying by canonical CID preserves codec,
    // so a dag-pb link cannot be satisfied by a raw block of the same bytes.
    const wanted = new Set<string>([cidKey(root)]);
    const received = new Set<string>();
    let blockCount = 0;

    for await (const { cid, bytes } of car) {
      if (bytes.byteLength > MAX_BLOCK_BYTES) {
        throw new Error("block exceeded max byte length");
      }
      if (++blockCount > maxBlockCount) {
        throw new Error("CAR file exceeded max block count");
      }

      const key = cidKey(cid);
      if (!wanted.has(key)) {
        throw new Error("CID has not been referenced yet");
      }

      const codec = getCodec(cid.code);
      const hasher = getHasher(cid.multihash.code);
      const block = await create({ bytes, cid, codec, hasher });

      wanted.delete(key);
      received.add(key);

      if (codec.code === CODEC_DAG_PB || codec.code === CODEC_DAG_CBOR) {
        for (const [, link] of block.links()) {
          const linkKey = cidKey(link);
          if (!received.has(linkKey) && !wanted.has(linkKey)) {
            wanted.add(linkKey);
          }
        }
      }

      yield block;
    }

    if (wanted.size > 0) {
      throw new Error("CAR incomplete: referenced blocks not delivered");
    }
  };

  try {
    log("importing car stream");
    // the write side should be closed after import completes
    await importer.import({ blocks }, options);
    log("finished importing car stream");
  } catch (e) {
    log.error("failed while reading car stream");
    throw e;
  }
}

export interface Allow {
  /** Whether the dialer's key may push at all. */
  multihash(
    dialerPublicKey: SupportedPrivateKey["publicKey"],
    options?: AbortOptions,
  ): boolean | Promise<boolean>;
  /**
   * Whether to accept `record` for `name`. The authoritative downgrade guard:
   * reject (return false) to abort the stream before the CAR is imported.
   */
  record(
    name: IpnsMultihash,
    record: IPNSRecord,
    options?: AbortOptions,
  ): boolean | Promise<boolean>;
}

export interface CreateHandlerOptions extends ReadCarFileOptions {
  /** Idle timeout (ms): abort if no bytes arrive for this long while receiving. */
  idleTimeoutMs?: number;
}

/**
 * A record received and validated by the handler, ready for the caller to pin
 * and publish to routers.
 */
export interface ReceivedRecord {
  /** The dialer's IPNS key. */
  name: IpnsMultihash;
  /** The received, signature-validated IPNS record. */
  record: IPNSRecord;
  /** The dialer's libp2p key, used as the pinner. */
  pinner: Libp2pKey;
}

/**
 * Called once the handler has received and signature-validated a record and
 * imported its CAR into the blockstore. Implementations own the durable side:
 * recording the work, pinning the content, and publishing the record to
 * routers. The handler awaits this before closing the stream as success, so it
 * should return promptly once it has durably recorded enough to recover the
 * work, running the slow pin and DHT publish in the background.
 */
export type OnReceive = (
  received: ReceivedRecord,
  options?: AbortOptions,
) => Promise<void>;

/**
 * Run the challenge/response handshake for an already-read dialer IPNS key: the
 * dialer must sign the handler's nonce to prove ownership of the key. Throws if
 * the key type is unsupported, the dialer is not allowed, or the signature is
 * invalid. The handler side of the handshake.
 */
export async function authenticateDialer(
  bs: ByteStream<Stream>,
  handlerPeerId: PeerId,
  dialerIpns: IpnsMultihash,
  allow: Allow,
  log: Logger,
  signal: AbortSignal,
): Promise<Libp2pKey> {
  const dialerPublicKey = publicKeyFromMultihash(dialerIpns);

  if (
    dialerPublicKey.type !== "Ed25519" && dialerPublicKey.type !== "secp256k1"
  ) {
    const error = new Error("Unsupported Ipns key type");
    log.error(error.message);
    throw error;
  }
  const dialerLibp2pKey = dialerPublicKey.toCID();

  if (!(await allow.multihash(dialerPublicKey, { signal }))) {
    const error = new Error("ipns key not allowed");
    log.error(error.message);
    throw error;
  }
  log("ipns key %c is allowed", dialerLibp2pKey);
  log("contenthash is %s", contenthash(dialerPublicKey));

  let handlerNonce: Uint8Array;
  try {
    handlerNonce = generateNonce();
    await writeChallengeNonce(bs, handlerNonce, { signal });
  } catch (e) {
    log.error("failed while writing challenge nonce");
    throw e;
  }

  let valid: boolean;
  try {
    const [dialerNonce, sig] = await readChallengeResponse(bs, { signal });
    const challenge = buildChallenge(
      handlerPeerId,
      dialerIpns,
      handlerNonce,
      dialerNonce,
    );
    valid = await verifyChallenge(dialerPublicKey, challenge, sig, { signal });
  } catch (e) {
    log.error("failed while validating challenge response");
    throw e;
  }

  if (!valid) {
    const error = new Error("Dialer challenge response invalid");
    log.error(error.message);
    throw error;
  }
  log("dialer completed challenge");

  return dialerLibp2pKey;
}

export const createZzzyncHandler =
  (
    handlerPeerId: PeerId,
    importer: Pick<Car, "import">,
    allow: Allow,
    onReceive: OnReceive,
    options: CreateHandlerOptions = {},
  ): StreamHandler =>
  async (stream: Stream, connection: Connection): Promise<void> => {
    const log = l.newScope(stream.id);
    const { signal, clear } = streamSignal(
      stream,
      options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    );

    try {
      log("new stream from %s", connection.remotePeer);

      const bs = byteStream(stream);

      const name = await readIpnsMultihash(bs, log, { signal });
      const pinner = await authenticateDialer(
        bs,
        handlerPeerId,
        name,
        allow,
        log,
        signal,
      );
      const record = await readIpnsRecord(bs, name, log, { signal });

      if (!(await allow.record(name, record, { signal }))) {
        const e = new Error("ipns record not allowed");
        log.error(e.message);
        // abort with the specific reason so the dialer sees it; the outer
        // catch's abort is then a no-op on the already-aborted stream
        stream.abort(e);
        throw e;
      }

      const value = parsedRecordValue(record.value);
      if (value == null) {
        const e = new Error(
          "Failed to parse value. Unsupported codec or hash.",
        );
        stream.abort(e);
        throw e;
      }

      await readCarFile(bs, importer, value, log, { ...options, signal });

      await onReceive({ name, record, pinner }, { signal });
      log("handed off received record");

      await stream.close({ signal });
      log("closed stream");
    } catch (e) {
      log.error("failed while processing stream - %e", e);
      if (e instanceof Error) {
        stream.abort(e);
      } else {
        stream.abort(new Error(String(e)));
      }
    } finally {
      clear();
    }
  };

/**
 * Register the zzzync push handler on a libp2p node under
 * `ZZZYNC_PUSH_PROTOCOL_ID`. Defaults `maxInboundStreams` to a small value;
 * pass `options` to override. Returns a function that unregisters it.
 */
export async function registerZzzyncHandler(
  libp2p: Pick<Libp2p, "handle" | "unhandle">,
  handler: StreamHandler,
  options?: StreamHandlerOptions,
): Promise<() => Promise<void>> {
  await libp2p.handle(ZZZYNC_PUSH_PROTOCOL_ID, handler, {
    maxInboundStreams: 5,
    ...options,
  });

  return async () => {
    await libp2p.unhandle(ZZZYNC_PUSH_PROTOCOL_ID);
  };
}
