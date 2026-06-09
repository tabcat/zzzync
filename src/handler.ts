import { type Car } from "@helia/car";
import type { Pins } from "@helia/interface";
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
  type DatastoreProgressEvents,
  type IPNS,
  type IPNSRoutingProgressEvents,
  ipnsSelector,
  type RepublishProgressEvents,
} from "@tabcat/helia-ipns";
import {
  type IPNSRecord,
  marshalIPNSRecord,
  multihashToIPNSRoutingKey,
  unmarshalIPNSRecord,
} from "ipns";
import { ipnsValidator } from "ipns/validator";
import { create } from "multiformats/block";
import * as Digest from "multiformats/hashes/digest";
import defer from "p-defer";
import * as varint from "uint8-varint";
import { Uint8ArrayList } from "uint8arraylist";
import { equals } from "uint8arrays";
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
import { pin, unpin } from "./pins.js";
import {
  contenthash,
  getCodec,
  getHasher,
  parsedRecordValue,
  streamSignal,
} from "./utils.js";

export const HANDLER_NAMESPACE = `${ZZZYNC}:handler`;

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
  allow(
    dialerPublicKey: SupportedPrivateKey["publicKey"],
    options?: AbortOptions,
  ): Promise<boolean> | boolean;
  start?(): Promise<void>;
  stop?(): Promise<void>;
}

export interface CreateHandlerOptions extends ReadCarFileOptions {
  allow?: Allow;
}

const _log = logger(HANDLER_NAMESPACE);

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

  if (
    options.allow && !(await options.allow.allow(dialerPublicKey, { signal }))
  ) {
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

/**
 * Resolve the local record for the dialer's key and decide how the incoming
 * record relates to it: whether the value changed, whether they are byte-equal,
 * and the local value (for unpinning). Throws if the remote record is worse than
 * the local one.
 */
async function selectRemoteRecord(
  ipns: IPNS,
  dialerIpns: IpnsMultihash,
  dialerLibp2pKey: Libp2pKey,
  remoteRecord: IPNSRecord,
  value: UnixFsCID,
  log: Logger,
  signal: AbortSignal,
): Promise<
  {
    localRecordValue: UnixFsCID | null;
    valueChanged: boolean;
    localRecordEqual: boolean;
  }
> {
  let localRecord: IPNSRecord | undefined;
  try {
    const resolved = await ipns.resolve(dialerIpns, { offline: true, signal });
    localRecord = resolved.record;
    log(
      "found local record for %c with value %s",
      dialerLibp2pKey,
      localRecord.value,
    );
  } catch (e) {
    if (
      e instanceof Error && (e.name === "RecordNotFoundError" || e
            .name === "RecordsFailedValidationError")
    ) {
      localRecord = undefined;
      log("no local record found for %c", dialerLibp2pKey);
    } else {
      log.error("failed while resolving local record");
      throw e;
    }
  }

  const localRecordValue = parsedRecordValue(localRecord?.value ?? "");
  const valueChanged = !value.equals(localRecordValue);

  // check that localRecord is not better than remoteRecord
  let localRecordEqual = false;
  if (!valueChanged && localRecord != null) {
    const records: [IPNSRecord, IPNSRecord] = [remoteRecord, localRecord];
    const marshaledRecords = records.map(marshalIPNSRecord) as [
      Uint8Array,
      Uint8Array,
    ];
    const selected = ipnsSelector(
      multihashToIPNSRoutingKey(dialerIpns),
      marshaledRecords,
    );

    if (selected !== 0) {
      const error = new Error(
        "Record received from remote was worse than local record.",
      );
      log.error(error);
      throw error;
    }

    if (equals(...marshaledRecords)) {
      localRecordEqual = true;
    }
  }

  return { localRecordValue, valueChanged, localRecordEqual };
}

export const createZzzyncHandler =
  (
    handlerPeerId: PeerId,
    ipns: IPNS,
    importer: Pick<Car, "import">,
    pins: Pins,
    options: CreateHandlerOptions = {},
  ): StreamHandler =>
  async (stream: Stream, connection: Connection): Promise<void> => {
    const log = _log.newScope(stream.id);

    const { signal, clear } = streamSignal(stream);

    try {
      log("new stream from %s", connection.remotePeer);

      const bs = byteStream(stream);

      let dialerIpns: IpnsMultihash;
      try {
        dialerIpns = await readIpnsMultihash(bs, { signal });
      } catch (e) {
        log.error("failed while reading ipns key from stream");
        throw e;
      }
      log("read ipns multihash %t", dialerIpns.bytes);

      const dialerLibp2pKey = await authenticateDialer(
        bs,
        handlerPeerId,
        dialerIpns,
        options,
        log,
        signal,
      );

      let remoteRecord: IPNSRecord;
      try {
        remoteRecord = await readIpnsRecord(bs, dialerIpns, { signal });
      } catch (e) {
        log.error("failed while reading ipns record from stream");
        throw e;
      }
      log("read ipns record with value %s", remoteRecord.value);
      const value = parsedRecordValue(remoteRecord.value);

      if (value == null) {
        const e = new Error(
          "Failed to parse value. Unsupported codec or hash.",
        );
        stream.abort(e);
        throw e;
      }

      const { localRecordValue, valueChanged, localRecordEqual } =
        await selectRemoteRecord(
          ipns,
          dialerIpns,
          dialerLibp2pKey,
          remoteRecord,
          value,
          log,
          signal,
        );

      try {
        log("importing car stream");
        await readCarFile(bs, importer, value, options);
        log("finished importing car stream");
      } catch (e) {
        log.error("failed while reading car stream");
        throw e;
      }

      await pin(pins, dialerLibp2pKey, value, { signal });

      log("republishing records to routers");
      const deferred = defer();
      const onProgress = (
        event:
          | RepublishProgressEvents
          | IPNSRoutingProgressEvents
          | DatastoreProgressEvents,
      ): void => {
        if (event.type === "ipns:routing:datastore:complete") {
          log("ipns record updated locally");
          deferred.resolve();
        }

        if (event.type === "ipns:routing:datastore:error") {
          log("failed to update record locally");
          deferred.reject();
        }
      };
      const republishing = ipns.republish(dialerIpns, {
        onProgress,
        record: remoteRecord,
        skipResolution: true,
      });
      if (!localRecordEqual) {
        await Promise.race([republishing, deferred.promise]);
      } else {
        log("ipns record already existed locally");
      }

      await stream.close({ signal });
      log("closed stream");

      if (valueChanged && localRecordValue != null) {
        try {
          await pins.isPinned(localRecordValue)
            && await unpin(pins, dialerLibp2pKey, localRecordValue, { signal });
        } catch (e) {
          if (e instanceof Error && e.name === "NotFoundError") {
            log("tried to unpin cid that was not pinned!");
            log.error(e);
          } else {
            throw e;
          }
        }
      } else {
        log("value unchanged, skipping unpin");
      }
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
