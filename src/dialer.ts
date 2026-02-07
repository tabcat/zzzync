import { Car, UnixFSExporter } from "@helia/car";
import {
  AbortOptions,
  EventHandler,
  Stream,
  StreamCloseEvent,
} from "@libp2p/interface";
import { logger } from "@libp2p/logger";
import {
  ByteStream,
  byteStream,
  Filter,
  messageStreamToDuplex,
} from "@libp2p/utils";
import { IPNSPublishResult, IPNSRecord } from "@tabcat/helia-ipns";
import { anySignal } from "any-signal";
import { marshalIPNSRecord } from "ipns";
import type { Duplex } from "it-stream-types";
import { CID } from "multiformats/cid";
import * as varint from "uint8-varint";
import { Uint8ArrayList } from "uint8arraylist";
import { ZZZYNC } from "./constants.js";
import { IpnsMultihash } from "./interface.js";
import { parsedRecordValue, publicKeyAsIpnsMultihash } from "./utils.js";

export const PUSH_NAMESPACE = `${ZZZYNC}:push`;

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

export async function writeIpnsRecord(
  bs: ByteStream<Stream>,
  record: IPNSRecord,
  options: AbortOptions = {},
): Promise<void> {
  return writeVarintPrefixed(bs, marshalIPNSRecord(record), options);
}

export async function writeCarFile(
  duplex: Pick<
    Duplex<AsyncGenerator<Uint8ArrayList | Uint8Array<ArrayBufferLike>>>,
    "sink"
  >,
  exporter: Pick<Car, "export">,
  cid: CID,
  options: AbortOptions = {},
): Promise<void> {
  const references = new Set<string>();
  const blockFilter: Filter = {
    add: (bytes) => references.add(bytes.toString()),
    has: (bytes) => references.has(bytes.toString()),
  };
  await duplex.sink(exporter.export(cid, {
    ...options,
    blockFilter, // dedupe
    exporter: new UnixFSExporter(),
    offline: true,
    signal: options.signal,
  }));
}

export async function zzzync(
  stream: Stream,
  exporter: Pick<Car, "export">,
  result: IPNSPublishResult,
  options: AbortOptions = {},
): Promise<void> {
  const log = logger(`${PUSH_NAMESPACE}:${stream.id}`);

  const controller = new AbortController();
  const abort: EventHandler<StreamCloseEvent> = (event: StreamCloseEvent) => {
    if (event.error != null) {
      controller.abort();
    }
  };
  stream.addEventListener("close", abort);
  const signal = anySignal([controller.signal, options.signal]);

  try {
    log("starting zzzync");

    const bs = byteStream(stream);

    const { record, publicKey } = result;

    const ipnsMultihash = publicKeyAsIpnsMultihash(publicKey);

    if (ipnsMultihash == null) {
      throw new Error("unsupported public key");
    }

    try {
      await writeIpnsMultihash(bs, ipnsMultihash, { signal });
      log("wrote ipns key");
    } catch (e) {
      log.error("failed while writing ipns key");
      throw e;
    }

    try {
      await writeIpnsRecord(bs, record, { signal });
      log("wrote ipns record");
    } catch (e) {
      log.error("failed while writing ipns record");
      throw e;
    }

    bs.unwrap();
    const duplex = messageStreamToDuplex(stream);

    const cid = parsedRecordValue(record.value);

    if (cid == null) {
      throw new Error("Unable to parse record value");
    }

    try {
      await writeCarFile(duplex, exporter, cid, { ...options, signal });

      log("wrote car file");
    } catch (e) {
      log.error("failed while writing car file");
      throw e;
    }

    log("waiting for remote to close write");
    await new Promise((resolve) =>
      stream.addEventListener("remoteCloseWrite", resolve, {
        once: true,
        signal,
      })
    );
  } finally {
    signal.clear();
  }
}
