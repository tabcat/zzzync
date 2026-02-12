import { type Car } from "@helia/car";
import type { Pins } from "@helia/interface";
import { type Block, CarBlockIterator } from "@ipld/car/iterator";
import { publicKeyFromMultihash } from "@libp2p/crypto/keys";
import type {
  AbortOptions,
  Connection,
  EventHandler,
  PeerId,
  Stream,
  StreamCloseEvent,
  StreamHandler,
} from "@libp2p/interface";
import { logger } from "@libp2p/logger";
import {
  type ByteStream,
  byteStream,
  messageStreamToDuplex,
} from "@libp2p/utils";
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
import { isUint8ArrayList, Uint8ArrayList } from "uint8arraylist";
import { equals } from "uint8arrays";
import { buildChallenge, generateNonce } from "./challenge.js";
import {
  CODEC_DAG_PB,
  CODEC_IDENTITY,
  CODEC_SHA2_256,
  ZZZYNC,
} from "./constants.js";
import type { IpnsMultihash, UnixFsCID } from "./interface.js";
import { pin, unpin } from "./pins.js";
import { getCodec, getHasher, parsedRecordValue } from "./utils.js";

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

async function* normalizeUint8Array(
  source: AsyncIterable<Uint8Array | Uint8ArrayList>,
): AsyncIterable<Uint8Array> {
  for await (const bytes of source) {
    if (isUint8ArrayList(bytes)) {
      yield* bytes;
    } else {
      yield bytes;
    }
  }
}

interface ReadCarFileOptions {
  maxByteLength?: number;
}

export async function* readCarFile(
  source: AsyncGenerator<Uint8ArrayList | Uint8Array>,
  expectedRoot: UnixFsCID,
  options: ReadCarFileOptions = {},
): AsyncGenerator<Block> {
  const maxByteLength = options.maxByteLength ?? Infinity;
  const car = await CarBlockIterator.fromIterable(normalizeUint8Array(source));

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
}

export type AllowFn = (
  ipnsMultihash: IpnsMultihash,
  options?: AbortOptions,
) => Promise<boolean> | boolean;

export interface CreateHandlerOptions extends ReadCarFileOptions {
  allow?: AllowFn;
}

const _log = logger(HANDLER_NAMESPACE);

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

    const controller = new AbortController();
    const signal = controller.signal;
    const abort: EventHandler<StreamCloseEvent> = (event: StreamCloseEvent) => {
      if (event.error != null) {
        controller.abort();
      }
    };
    stream.addEventListener("close", abort);

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
      log(`read ipns multihash %t`, dialerIpns.bytes);

      const dialerPublicKey = publicKeyFromMultihash(dialerIpns);

      if (
        dialerPublicKey.type !== "Ed25519"
        && dialerPublicKey.type !== "secp256k1"
      ) {
        const error = new Error("Unsupported Ipns key type");
        log.error(error.message);
        throw error;
      }
      const dialerLibp2pKey = dialerPublicKey.toCID();

      if (options.allow && !(await options.allow(dialerIpns, { signal }))) {
        const error = new Error("ipns key not allowed");
        log.error(error.message);
        throw error;
      }
      log("ipns key %c is allowed", dialerLibp2pKey);

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
      } else {
        log("dialer completed challenge");
      }

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
        stream.close();
        throw new Error("Failed to parse value. Unsupported codec or hash.");
      }

      let localRecord: IPNSRecord | undefined;
      try {
        const resolved = await ipns.resolve(dialerIpns, {
          offline: true,
          signal,
        });
        localRecord = resolved.record;
        log(
          "found local record for %c with value %s",
          dialerLibp2pKey,
          localRecord.value,
        );
      } catch (e) {
        if (
          e instanceof Error && (e.name === "RecordNotFoundError" || e
                .name === "RecordsFaileValidationError")
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

      bs.unwrap();
      const { source } = messageStreamToDuplex(stream);

      try {
        log("importing car stream");
        // the write side should be closed after import completes
        await importer.import({
          blocks: () => readCarFile(source, value, options),
        }, { signal });
        log("finished importing car stream");
      } catch (e) {
        log.error("failed while reading car stream");
        throw e;
      }

      if (valueChanged) {
        await pin(pins, dialerLibp2pKey, value, { signal });
      } else {
        log("value did not change. skipping pin");
      }

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
      stream.removeEventListener("close", abort);
    }
  };
