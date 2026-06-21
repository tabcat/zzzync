import { Car, UnixFSExporter } from "@helia/car";
import {
  AbortOptions,
  Libp2p,
  Logger,
  PeerId,
  Stream,
} from "@libp2p/interface";
import { logger } from "@libp2p/logger";
import { ByteStream, byteStream, Filter } from "@libp2p/utils";
import { IPNSPublishResult, IPNSRecord } from "@tabcat/helia-ipns";
import { marshalIPNSRecord } from "ipns";
import { CID } from "multiformats/cid";
import * as varint from "uint8-varint";
import { Uint8ArrayList } from "uint8arraylist";
import { buildChallenge, generateNonce, Sign } from "./challenge.ts";
import { ZZZYNC, ZZZYNC_PUSH_PROTOCOL_ID } from "./constants.ts";
import { IpnsMultihash } from "./interface.ts";
import {
  parsedRecordValue,
  publicKeyAsIpnsMultihash,
  streamSignal,
} from "./utils.ts";

export const DIALER_NAMESPACE = `${ZZZYNC}:dialer`;
const l = logger(DIALER_NAMESPACE);

export async function writeVarint(
  bs: ByteStream<Stream>,
  n: number,
  options: AbortOptions,
): Promise<void> {
  return bs.write(varint.encode(n), options);
}

export async function writeVarintPrefixed(
  bs: ByteStream<Stream>,
  bytes: Uint8Array,
  options: AbortOptions = {},
): Promise<void> {
  return bs.write(
    new Uint8ArrayList(varint.encode(bytes.length), bytes),
    options,
  );
}

export async function writeIpnsMultihash(
  bs: ByteStream<Stream>,
  ipnsMultihash: IpnsMultihash,
  options: AbortOptions = {},
): Promise<void> {
  return bs.write(ipnsMultihash.bytes, options);
}

export async function readNonce(
  bs: ByteStream<Stream>,
  options: AbortOptions = {},
): Promise<Uint8Array> {
  return (await bs.read({ bytes: 32, signal: options.signal })).subarray();
}

export async function writeChallengeResponse(
  bs: ByteStream<Stream>,
  dialerNonce: Uint8Array,
  sig: Uint8Array,
  options: AbortOptions = {},
): Promise<void> {
  await bs.write(new Uint8ArrayList(dialerNonce, sig), options);
}

export async function writeIpnsRecord(
  bs: ByteStream<Stream>,
  record: IPNSRecord,
  options: AbortOptions = {},
): Promise<void> {
  return writeVarintPrefixed(bs, marshalIPNSRecord(record), options);
}

export async function writeCarFile(
  bs: ByteStream<Stream>,
  exporter: Pick<Car, "export">,
  cid: CID,
  options: AbortOptions = {},
): Promise<void> {
  const references = new Set<string>();
  const blockFilter: Filter = {
    add: (bytes) => references.add(bytes.toString()),
    has: (bytes) => references.has(bytes.toString()),
  };
  for await (
    const data of exporter.export(cid, {
      ...options,
      blockFilter, // dedupe
      exporter: new UnixFSExporter(),
      offline: true,
      signal: options.signal,
    })
  ) {
    await bs.write(data);
  }
}

/**
 * Read the handler's nonce, sign the challenge (bound to `dialerIpns`), and send
 * the response. The caller must have already announced the dialer's key. The
 * dialer side of the challenge/response (see spec.md).
 */
export async function completeChallenge(
  bs: ByteStream<Stream>,
  handlerPeerId: PeerId,
  dialerIpns: IpnsMultihash,
  sign: Sign,
  log: Logger,
  signal: AbortSignal,
): Promise<void> {
  let handlerNonce: Uint8Array;
  try {
    handlerNonce = await readNonce(bs, { signal });
    log("read handler nonce");
  } catch (e) {
    log.error("failed while reading challenge nonce");
    throw e;
  }

  try {
    const dialerNonce = generateNonce();
    const challenge = buildChallenge(
      handlerPeerId,
      dialerIpns,
      handlerNonce,
      dialerNonce,
    );
    const sig = await sign(challenge, { signal }); // raw sig 64 byte length
    await writeChallengeResponse(bs, dialerNonce, sig, { signal });
    log("wrote response to challenge");
  } catch (e) {
    log.error("failed while writing challenge response");
    throw e;
  }
}

export async function zzzync(
  stream: Stream,
  handlerPeerId: PeerId,
  exporter: Pick<Car, "export">,
  result: IPNSPublishResult,
  sign: Sign,
  options: AbortOptions = {},
): Promise<void> {
  const log = l.newScope(stream.id);
  const { signal, clear } = streamSignal(stream, options);

  try {
    log("starting zzzync");

    const bs = byteStream(stream);

    const { record, publicKey } = result;

    const dialerIpns = publicKeyAsIpnsMultihash(publicKey);

    if (dialerIpns == null) {
      throw new Error("unsupported public key");
    }

    try {
      await writeIpnsMultihash(bs, dialerIpns, { signal });
      log("wrote ipns key");
    } catch (e) {
      log.error("failed while writing ipns key");
      throw e;
    }

    await completeChallenge(bs, handlerPeerId, dialerIpns, sign, log, signal);

    try {
      await writeIpnsRecord(bs, record, { signal });
      log("wrote ipns record");
    } catch (e) {
      log.error("failed while writing ipns record");
      throw e;
    }

    const cid = parsedRecordValue(record.value);

    if (cid == null) {
      throw new Error("Unable to parse record value");
    }

    try {
      await writeCarFile(bs, exporter, cid, { ...options, signal });
      await stream.close();
      log("wrote car file");
    } catch (e) {
      log.error("failed while writing car file");
      throw e;
    }

    log("waiting for remote to close write");
    await new Promise((resolve, reject) => {
      signal.throwIfAborted();
      stream.addEventListener("remoteCloseWrite", resolve, {
        once: true,
        signal,
      });
      signal.addEventListener("abort", reject);
    });
  } finally {
    clear();
  }
}

/**
 * Dial a peer on `ZZZYNC_PUSH_PROTOCOL_ID` and run the zzzync dialer over the
 * opened stream. `peerId` is both the dial target and the handler peer id the
 * challenge is bound to.
 */
export async function dialZzzync(
  libp2p: Pick<Libp2p, "dialProtocol">,
  peerId: PeerId,
  exporter: Pick<Car, "export">,
  result: IPNSPublishResult,
  sign: Sign,
  options: AbortOptions = {},
): Promise<void> {
  const stream = await libp2p.dialProtocol(
    peerId,
    ZZZYNC_PUSH_PROTOCOL_ID,
    options,
  );
  await zzzync(stream, peerId, exporter, result, sign, options);
}
