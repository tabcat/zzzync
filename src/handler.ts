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
import { create } from "multiformats/block";
import * as Digest from "multiformats/hashes/digest";
import * as varint from "uint8-varint";
import { Uint8ArrayList } from "uint8arraylist";
import {
  buildChallenge,
  generateNonce,
  SupportedPrivateKey,
} from "./challenge.js";
import {
  CODEC_DAG_PB,
  CODEC_IDENTITY,
  CODEC_SHA2_256,
  ZZZYNC,
  ZZZYNC_PUSH_PROTOCOL_ID,
} from "./constants.js";
import type { IpnsMultihash, Libp2pKey, UnixFsCID } from "./interface.js";
import {
  contenthash,
  getCodec,
  getHasher,
  parsedRecordValue,
  streamSignal,
} from "./utils.js";

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
  let byte = await readByte(bs);
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

export type VarintGuard<T extends number = number> = (
  n: number,
) => asserts n is T;

export async function readVarintPrefixed<T extends number>(
  bs: ByteStream<Stream>,
  varintGuard: VarintGuard<T>,
  options: AbortOptions = {},
): Promise<[T, Uint8ArrayList]> {
  const n = await readVarint(bs, options);

  varintGuard(n);

  return [n as T, await bs.read({ bytes: n })];
}

const validateIpnsCode: VarintGuard<
  typeof CODEC_IDENTITY | typeof CODEC_SHA2_256
> = (n: number) => {
  if (n !== CODEC_IDENTITY && n !== CODEC_SHA2_256) {
    throw new Error("UNSUPPORTED_IPNS_KEY");
  }
};

export async function readIpnsMultihash(
  bs: ByteStream<Stream>,
  options: AbortOptions = {},
): Promise<IpnsMultihash> {
  let [code, digest] = await readVarintPrefixed(bs, validateIpnsCode, options);

  if (code === CODEC_IDENTITY) {
    const [, _digest] = await readVarintPrefixed(bs, () => {}, options);
    digest = _digest;
  } else {
    throw new Error("Expected identity multihash.");
  }

  return Digest.create(code, digest.subarray());
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
  options: AbortOptions = {},
): Promise<IPNSRecord> {
  const recordLength = await readVarint(bs, options);
  const marshalledRecord =
    (await bs.read({ bytes: recordLength, signal: options.signal })).subarray();

  await ipnsValidator(
    multihashToIPNSRoutingKey(ipnsMultihash),
    marshalledRecord,
  );

  return unmarshalIPNSRecord(marshalledRecord);
}

interface ReadCarFileOptions extends AbortOptions {
  maxByteLength?: number;
}

export async function readCarFile(
  bs: ByteStream<Stream>,
  importer: Pick<Car, "import">,
  expectedRoot: UnixFsCID,
  options: ReadCarFileOptions = {},
): Promise<void> {
  const blocks = async function*() {
    const maxByteLength = options.maxByteLength ?? Infinity;
    const car = await CarBlockIterator.fromIterable(
      (async function*(): AsyncIterable<Uint8Array> {
        while (true) {
          const byteList = await bs.read();

          if (byteList == null) break;

          yield* byteList;
        }
      })(),
    );

    const [root] = await car.getRoots();

    if (root == null || !root.equals(expectedRoot)) {
      throw new Error("ERR_UNEXPECTED_ROOT");
    }

    const references = new Set<string>([root.toString()]);
    let byteLength = 0;
    for await (const { cid, bytes } of car) {
      byteLength += bytes.byteLength;

      if (byteLength > maxByteLength) {
        throw new Error("CAR file exceeded max byte length");
      }

      const cidstring = cid.toString();
      if (!references.has(cidstring)) {
        throw new Error("CID has not been referenced yet");
      }
      references.delete(cidstring);

      // getCodec will return raw codec if no codec found
      const codec = getCodec(cid.code);
      const hasher = getHasher(cid.multihash.code);
      const block = await create({ bytes, cid, codec, hasher });

      if (codec.code === CODEC_DAG_PB) {
        for (const [_, link] of block.links()) {
          references.add(link.toString());
        }
      }

      yield block;
    }
  };

  // the write side should be closed after import completes
  await importer.import({ blocks }, options);
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
   * ice-queen wires this to its registry.
   */
  record(
    name: IpnsMultihash,
    record: IPNSRecord,
    options?: AbortOptions,
  ): boolean | Promise<boolean>;
}

export interface CreateHandlerOptions extends ReadCarFileOptions {
  allow?: Allow;
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
 * invalid. The handler side of the handshake (see spec.md).
 */
export async function authenticateDialer(
  bs: ByteStream<Stream>,
  handlerPeerId: PeerId,
  dialerIpns: IpnsMultihash,
  options: CreateHandlerOptions,
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

  if (!(await options.allow?.multihash(dialerPublicKey, { signal }) ?? true)) {
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
    valid = await dialerPublicKey.verify(challenge, sig, { signal });
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
    onReceive: OnReceive,
    options: CreateHandlerOptions = {},
  ): StreamHandler =>
  async (stream: Stream, connection: Connection): Promise<void> => {
    const log = l.newScope(stream.id);
    const { signal, clear } = streamSignal(stream);

    try {
      log("new stream from %s", connection.remotePeer);

      const bs = byteStream(stream);

      let name: IpnsMultihash;
      try {
        name = await readIpnsMultihash(bs, { signal });
      } catch (e) {
        log.error("failed while reading ipns key from stream");
        throw e;
      }
      log("read ipns multihash %t", name.bytes);

      const pinner = await authenticateDialer(
        bs,
        handlerPeerId,
        name,
        options,
        log,
        signal,
      );

      let record: IPNSRecord;
      try {
        record = await readIpnsRecord(bs, name, { signal });
      } catch (e) {
        log.error("failed while reading ipns record from stream");
        throw e;
      }
      log("read ipns record with value %s", record.value);

      if (!(await options.allow?.record(name, record, { signal }) ?? true)) {
        const e = new Error("ipns record not allowed");
        log.error(e.message);
        // abort with the specific reason so the dialer sees it; the outer catch's
        // abort is then a no-op on the already-aborted stream
        stream.abort(e);
        throw e;
      }

      const value = parsedRecordValue(record.value);
      if (value == null) {
        const e = new Error(
          "Failed to parse value. Unsupported codec or hash.",
        );
        // abort with the specific reason so the dialer sees it; the outer catch's
        // abort is then a no-op on the already-aborted stream
        stream.abort(e);
        throw e;
      }

      try {
        log("importing car stream");
        await readCarFile(bs, importer, value, options);
        log("finished importing car stream");
      } catch (e) {
        log.error("failed while reading car stream");
        throw e;
      }

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
 * `ZZZYNC_PUSH_PROTOCOL_ID`. Returns a function that unregisters it.
 */
export async function registerZzzyncHandler(
  libp2p: Pick<Libp2p, "handle" | "unhandle">,
  handler: StreamHandler,
  options?: StreamHandlerOptions,
): Promise<() => Promise<void>> {
  await libp2p.handle(ZZZYNC_PUSH_PROTOCOL_ID, handler, options);

  return async () => {
    await libp2p.unhandle(ZZZYNC_PUSH_PROTOCOL_ID);
  };
}
