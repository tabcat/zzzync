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
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_MAX_AUTH_FRAME_BYTES,
  DEFAULT_MAX_STREAM_MS,
  DEFAULT_MIN_BYTES_PER_SECOND,
  DEFAULT_RACE_TIMEOUT_MS,
  DEFAULT_RATE_WINDOW_MS,
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
  raceDeadline,
  streamSignal,
  StreamSignalOptions,
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

    // uint8-varint decodes at most 8 bytes (56 bits); a 9th continuation byte
    // makes varint.decode throw, so stop here and let it validate the rest
    if (varintBytes.length === 8) {
      break;
    }
  }

  return varint.decode(new Uint8Array(varintBytes));
}

export async function readAuth(
  bs: ByteStream<Stream>,
  maxBytes: number,
  options?: AbortOptions,
): Promise<Uint8Array | undefined> {
  const length = await readVarint(bs, options);
  if (length === 0) {
    return undefined;
  }
  if (length > maxBytes) {
    throw new Error("auth frame exceeds max size");
  }
  return (await bs.read({ bytes: length, signal: options?.signal })).subarray();
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

/**
 * Size limits for a received CAR. The CAR format specifies no maximum of any
 * kind (CARv1 states there is no constraint in the header regarding total
 * length, and its varints are unbounded), so every cap here is policy an
 * application chooses rather than anything the format implies.
 */
/**
 * Size limits for a received CAR. Every field is required: the CAR format
 * specifies no maximum of any kind, so there is no default zzzync could pick
 * that would not be invented. Pass `Infinity` for a cap you genuinely do not
 * want, so that "no limit" is something the call site says rather than
 * something it inherits by omission.
 *
 * `maxCarSectionSize` and `maxCarHeaderSize` go to @ipld/car, which checks them
 * against a declared length before reading the body, so an over-cap claim costs
 * nothing. Both must be non-negative safe integers; @ipld/car rejects Infinity,
 * so use its own generous defaults there rather than trying to disable them.
 */
export interface CarLimits {
  /**
   * Total raw bytes accepted, CAR framing included. `Infinity` is accepted
   * here. Note the transport buffers at most 4MiB of unconsumed bytes
   * regardless, and overruns that.
   */
  maxByteLength: number;
  /** Blocks accepted. `Infinity` is accepted here. */
  maxBlockCount: number;
  /**
   * Largest CAR section: block bytes plus their CID. Goes to @ipld/car, which
   * requires a non-negative safe integer and throws a TypeError on `Infinity`.
   * To not cap this, pass its own default of 8 * 1024 * 1024.
   */
  maxCarSectionSize: number;
  /**
   * Largest CAR header. A one-root header is around 58 bytes. Same @ipld/car
   * restriction as `maxCarSectionSize`: no `Infinity`. To not cap this, pass
   * its own default of 32 * 1024 * 1024.
   */
  maxCarHeaderSize: number;
}

/** Canonical (v1, base32) CID key so codec differences are preserved. */
const cidKey = (cid: CID): string => cid.toV1().toString(base32);

export async function readCarFile(
  bs: ByteStream<Stream>,
  importer: Pick<Car, "import">,
  expectedRoot: UnixFsCID,
  log: Logger,
  limits: CarLimits,
  options: AbortOptions = {},
): Promise<void> {
  const { maxByteLength, maxBlockCount } = limits;

  const blocks = async function*() {
    // Bound the raw bytes fed to the CAR decoder. maxCarSectionSize and
    // maxCarHeaderSize cap any single declared length before its body is read,
    // but nothing in @ipld/car bounds the total, and maxBlockCount further down
    // only counts a block once it is fully materialized. This budget is what
    // bounds the total across all sections, plus bytes the decoder skips or
    // never parses as a section at all (a CARv2 pragma seeks past dataOffset),
    // and counting raw bytes makes maxByteLength cover CAR framing rather than
    // just decoded block payload.
    let pulled = 0;
    const car = await CarBlockIterator.fromIterable(
      (async function*(): AsyncIterable<Uint8Array> {
        while (true) {
          const byteList = await bs.read({ signal: options.signal });

          if (byteList == null) break;

          pulled += byteList.byteLength;
          if (maxByteLength != null && pulled > maxByteLength) {
            throw new Error("CAR file exceeded max byte length");
          }

          yield* byteList;
        }
      })(),
      {
        maxAllowedSectionSize: limits.maxCarSectionSize,
        maxAllowedHeaderSize: limits.maxCarHeaderSize,
      },
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
      blockCount++;
      if (maxBlockCount != null && blockCount > maxBlockCount) {
        throw new Error("CAR file exceeded max block count");
      }

      const key = cidKey(cid);
      if (!wanted.has(key)) {
        throw new Error("CID has not been referenced yet");
      }

      const codec = getCodec(cid.code);
      const hasher = getHasher(cid.multihash.code);
      // @ipld/car only parses CAR structure, it does not verify blocks, so this
      // is the integrity gate: create() re-hashes the bytes and throws if they do
      // not match the claimed CID. Keep it create(), never createUnsafe().
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

export interface AllowOptions extends AbortOptions {
  /** The dialer's optional auth frame (a delegation-chain CAR), read after its ipns key. */
  auth?: Uint8Array;
}

export interface Allow {
  /** Whether the dialer's key may push at all. */
  multihash(
    dialerPublicKey: SupportedPrivateKey["publicKey"],
    options?: AllowOptions,
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

/**
 * Timing for a handler. Size limits are a separate required argument, not an
 * option, so they cannot be omitted by accident.
 *
 * The timing fields come from `StreamSignalOptions` rather than being restated,
 * made partial because each has a DEFAULT_ constant behind it.
 */
export interface CreateHandlerOptions
  extends Partial<StreamSignalOptions>, AuthOptions
{}

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
 * Config the handshake needs, which a handler carries too. Defined once so the
 * two cannot drift: they previously held the same auth-frame cap under
 * different names and translated between them by hand.
 */
export interface AuthOptions {
  /** Max bytes for the dialer's optional auth frame. Defaults to DEFAULT_MAX_AUTH_FRAME_BYTES. */
  maxAuthFrameBytes?: number;
  /**
   * Deadline (ms) for each raced application callback. Through
   * `authenticateDialer` alone that is `allow.multihash`; through a handler it
   * is `allow.record` and `onReceive` as well.
   */
  raceTimeoutMs?: number;
}

export interface AuthenticateDialerOptions extends AbortOptions, AuthOptions {}

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
  options?: AuthenticateDialerOptions,
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

  const maxBytes = options?.maxAuthFrameBytes ?? DEFAULT_MAX_AUTH_FRAME_BYTES;
  const raceTimeoutMs = options?.raceTimeoutMs ?? DEFAULT_RACE_TIMEOUT_MS;
  const auth = await readAuth(bs, maxBytes, { signal: options?.signal });

  const permitted = await raceDeadline(
    (deadline) => allow.multihash(dialerPublicKey, { signal: deadline, auth }),
    raceTimeoutMs,
    "allow.multihash exceeded its deadline",
    options?.signal,
  );
  if (!permitted) {
    const error = new Error("ipns key not allowed");
    log.error(error.message);
    throw error;
  }
  log("ipns key %c is allowed", dialerLibp2pKey);
  log("contenthash is %s", contenthash(dialerPublicKey));

  let handlerNonce: Uint8Array;
  try {
    handlerNonce = generateNonce();
    await writeChallengeNonce(bs, handlerNonce, { signal: options?.signal });
  } catch (e) {
    log.error("failed while writing challenge nonce");
    throw e;
  }

  let valid: boolean;
  try {
    const [dialerNonce, sig] = await readChallengeResponse(bs, {
      signal: options?.signal,
    });
    const challenge = buildChallenge(
      handlerPeerId,
      dialerIpns,
      handlerNonce,
      dialerNonce,
    );
    valid = await verifyChallenge(dialerPublicKey, challenge, sig, {
      signal: options?.signal,
    });
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
    limits: CarLimits,
    onReceive: OnReceive,
    options: CreateHandlerOptions = {},
  ): StreamHandler =>
  async (stream: Stream, connection: Connection): Promise<void> => {
    const log = l.newScope(stream.id);
    const { signal, beginTransfer, clear } = streamSignal(stream, {
      idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
      handshakeTimeoutMs: options.handshakeTimeoutMs
        ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      maxStreamMs: options.maxStreamMs ?? DEFAULT_MAX_STREAM_MS,
      minBytesPerSecond: options.minBytesPerSecond
        ?? DEFAULT_MIN_BYTES_PER_SECOND,
      rateWindowMs: options.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS,
    });

    try {
      log("new stream from %s", connection.remotePeer);

      const bs = byteStream(stream);

      const raceTimeoutMs = options.raceTimeoutMs ?? DEFAULT_RACE_TIMEOUT_MS;

      const name = await readIpnsMultihash(bs, log, { signal });
      const pinner = await authenticateDialer(
        bs,
        handlerPeerId,
        name,
        allow,
        log,
        { signal, maxAuthFrameBytes: options.maxAuthFrameBytes, raceTimeoutMs },
      );
      const record = await readIpnsRecord(bs, name, log, { signal });

      const accepted = await raceDeadline(
        (deadline) => allow.record(name, record, { signal: deadline }),
        raceTimeoutMs,
        "allow.record exceeded its deadline",
        signal,
      );
      if (!accepted) {
        const e = new Error("ipns record not allowed");
        log.error(e.message);
        // abort with the specific reason so the dialer sees it; the outer
        // catch's abort is then a no-op on the already-aborted stream
        stream.abort(e);
        throw e;
      }

      // Only now retire the handshake deadline and arm the throughput floor.
      // allow.record runs above it deliberately: it is an application callback
      // doing bounded work with no bytes arriving, so a wall-clock cap fits it
      // and a throughput floor does not. Under the floor, a delegation-chain
      // check or a cold cache would abort as "throughput below minimum" for a
      // reason that has nothing to do with throughput.
      beginTransfer();

      const value = parsedRecordValue(record.value);
      if (value == null) {
        const e = new Error(
          "Failed to parse value. Unsupported codec or hash.",
        );
        stream.abort(e);
        throw e;
      }

      await readCarFile(bs, importer, value, log, limits, { signal });

      await raceDeadline(
        (deadline) => onReceive({ name, record, pinner }, { signal: deadline }),
        raceTimeoutMs,
        "onReceive exceeded its deadline",
        signal,
      );
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
