import { Car, UnixFSExporter } from "@helia/car";
import { AbortOptions, Libp2p, PeerId, Stream } from "@libp2p/interface";
import { logger } from "@libp2p/logger";
import { ByteStream, byteStream, Filter } from "@libp2p/utils";
import { IPNSRecord, marshalIPNSRecord } from "ipns";
import { CID } from "multiformats/cid";
import * as varint from "uint8-varint";
import { Uint8ArrayList } from "uint8arraylist";
import { buildChallenge, generateNonce, Sign } from "./challenge.ts";
import {
  DEFAULT_ACK_TIMEOUT_MS,
  DEFAULT_WRITE_TIMEOUT_MS,
  ZZZYNC,
  ZZZYNC_PUSH_PROTOCOL_ID,
} from "./constants.ts";
import { IpnsMultihash, PushInput } from "./interface.ts";
import {
  DeadlineOptions,
  deadlineSignal,
  eventPromise,
  parsedRecordValue,
  publicKeyAsIpnsMultihash,
  streamSignal,
  withDeadline,
} from "./utils.ts";

export const DIALER_NAMESPACE = `${ZZZYNC}:dialer`;
const l = logger(DIALER_NAMESPACE);

export interface DialOptions extends AbortOptions {
  /** Per-step deadline (ms) for each read/write step: handshake, record, CAR chunk. */
  writeTimeoutMs?: number;
  /** Deadline (ms) waiting for the handler to close its write side after the CAR. */
  ackTimeoutMs?: number;
}

async function writeVarintPrefixed(
  bs: ByteStream<Stream>,
  bytes: Uint8Array,
  options: AbortOptions = {},
): Promise<void> {
  return bs.write(
    new Uint8ArrayList(varint.encode(bytes.length), bytes),
    options,
  );
}

const writeKey = (
  bs: ByteStream<Stream>,
  dialerIpns: IpnsMultihash,
  options: DeadlineOptions,
): Promise<void> =>
  withDeadline(
    (deadline) => bs.write(dialerIpns.bytes, { signal: deadline }),
    "wrote ipns key",
    "failed while writing ipns key",
    options,
  );

const readHandlerNonce = (
  bs: ByteStream<Stream>,
  options: DeadlineOptions,
): Promise<Uint8Array> =>
  withDeadline(
    async (deadline) =>
      (await bs.read({ bytes: 32, signal: deadline })).subarray(),
    "read handler nonce",
    "failed while reading challenge nonce",
    options,
  );

const respondToChallenge = (
  bs: ByteStream<Stream>,
  handlerPeerId: PeerId,
  dialerIpns: IpnsMultihash,
  handlerNonce: Uint8Array,
  sign: Sign,
  options: DeadlineOptions,
): Promise<void> =>
  withDeadline(
    async (deadline) => {
      const dialerNonce = generateNonce();
      const challenge = buildChallenge(
        handlerPeerId,
        dialerIpns,
        handlerNonce,
        dialerNonce,
      );
      const sig = await sign(challenge, { signal: deadline });
      await bs.write(new Uint8ArrayList(dialerNonce, sig), {
        signal: deadline,
      });
    },
    "wrote response to challenge",
    "failed while writing challenge response",
    options,
  );

/**
 * Announce the dialer's key and prove ownership: write the IPNS key, read the
 * handler's nonce, and send a signed response. Each step gets its own deadline.
 * The dialer side of the challenge/response.
 */
export async function authenticateToHandler(
  bs: ByteStream<Stream>,
  handlerPeerId: PeerId,
  dialerIpns: IpnsMultihash,
  sign: Sign,
  options: DeadlineOptions,
): Promise<void> {
  await writeKey(bs, dialerIpns, options);
  const handlerNonce = await readHandlerNonce(bs, options);
  await respondToChallenge(
    bs,
    handlerPeerId,
    dialerIpns,
    handlerNonce,
    sign,
    options,
  );
}

export const writeRecord = (
  bs: ByteStream<Stream>,
  record: IPNSRecord,
  options: DeadlineOptions,
): Promise<void> =>
  withDeadline(
    (deadline) =>
      writeVarintPrefixed(bs, marshalIPNSRecord(record), { signal: deadline }),
    "wrote ipns record",
    "failed while writing ipns record",
    options,
  );

export async function writeCarFile(
  bs: ByteStream<Stream>,
  exporter: Pick<Car, "export">,
  cid: CID,
  options: DeadlineOptions,
): Promise<void> {
  try {
    const references = new Set<string>();
    const blockFilter: Filter = {
      add: (bytes) => references.add(bytes.toString()),
      has: (bytes) => references.has(bytes.toString()),
    };
    for await (
      const data of exporter.export(cid, {
        blockFilter, // dedupe
        exporter: new UnixFSExporter(),
        offline: true,
        signal: options.signal,
      })
    ) {
      // each chunk write gets its own deadline; the gap between chunks (slow
      // blockstore reads) is not bounded
      const deadline = deadlineSignal(options.signal, options.timeoutMs);
      try {
        await bs.write(data, { signal: deadline.signal });
      } finally {
        deadline.clear();
      }
    }
    options.log("wrote car file");
  } catch (e) {
    options.log.error("failed while writing car file");
    throw e;
  }
}

export const awaitHandlerClose = (
  stream: Stream,
  options: DeadlineOptions,
): Promise<void> =>
  withDeadline(
    (deadline) => eventPromise(stream, "remoteCloseWrite", deadline),
    "remote closed write",
    "failed while waiting for remote to close write",
    options,
  );

export async function zzzync(
  stream: Stream,
  handlerPeerId: PeerId,
  exporter: Pick<Car, "export">,
  result: PushInput,
  sign: Sign,
  options: DialOptions = {},
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

    // handshake, record, and CAR writes all share the per-step write deadline
    const deadlineOptions: DeadlineOptions = {
      signal,
      timeoutMs: options.writeTimeoutMs ?? DEFAULT_WRITE_TIMEOUT_MS,
      log,
    };
    await authenticateToHandler(
      bs,
      handlerPeerId,
      dialerIpns,
      sign,
      deadlineOptions,
    );
    await writeRecord(bs, record, deadlineOptions);

    const cid = parsedRecordValue(record.value);
    if (cid == null) {
      throw new Error("Unable to parse record value");
    }

    await writeCarFile(bs, exporter, cid, deadlineOptions);
    await stream.close({ signal });

    await awaitHandlerClose(stream, {
      signal,
      timeoutMs: options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS,
      log,
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
  result: PushInput,
  sign: Sign,
  options: DialOptions = {},
): Promise<void> {
  const stream = await libp2p.dialProtocol(
    peerId,
    ZZZYNC_PUSH_PROTOCOL_ID,
    options,
  );
  await zzzync(stream, peerId, exporter, result, sign, options);
}
