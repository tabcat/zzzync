import { type Car, UnixFSExporter } from "@helia/car";
import type { Pins } from "@helia/interface";
import type { IPNS } from "@helia/ipns";
import { type Block, CarBlockIterator } from "@ipld/car/iterator";
// import * as DagPB from "@ipld/dag-pb";
import type { AbortOptions, Stream, StreamHandler } from "@libp2p/interface";
import { logger } from "@libp2p/logger";
import { peerIdFromMultihash } from "@libp2p/peer-id";
import {
	type ByteStream,
	byteStream,
	messageStreamToDuplex,
} from "@libp2p/utils";
import {
	type IPNSRecord,
	marshalIPNSRecord,
	multihashToIPNSRoutingKey,
	unmarshalIPNSRecord,
} from "ipns";
import { ipnsValidator } from "ipns/validator";
import type { Duplex } from "it-stream-types";
import type { CID } from "multiformats";
// import { create } from "multiformats/block";
import * as Digest from "multiformats/hashes/digest";
// import { sha256 } from "multiformats/hashes/sha2";
import { raceSignal } from "race-signal";
import * as varint from "uint8-varint";
import { isUint8ArrayList, Uint8ArrayList } from "uint8arraylist";
import {
	type CODEC_DAG_PB,
	CODEC_IDENTITY,
	// CODEC_RAW,
	CODEC_SHA2_256,
	ZZZYNC,
} from "./constants.js";
import type { IpnsMultihash, Libp2pKey } from "./interface.js";
import { pin, unpin } from "./pins.js";
import { parseRecordValue } from "./utils.js";

export const PUSH_NAMESPACE = `${ZZZYNC}:push`;
export const HANDLER_NAMESPACE = `${ZZZYNC}:handler`;

export async function writeVarint(
	bs: ByteStream<Stream>,
	n: number,
): Promise<void> {
	return bs.write(varint.encode(n));
}

export async function writeVarintPrefixed(
	bs: ByteStream<Stream>,
	bytes: Uint8Array,
): Promise<void> {
	return bs.write(new Uint8ArrayList(varint.encode(bytes.length), bytes));
}

export async function writeIpnsMultihash(
	bs: ByteStream<Stream>,
	ipnsMultihash: IpnsMultihash,
): Promise<void> {
	return bs.write(ipnsMultihash.bytes);
}

async function writeIpnsRecord(
	bs: ByteStream<Stream>,
	record: IPNSRecord,
): Promise<void> {
	return writeVarintPrefixed(bs, marshalIPNSRecord(record));
}

async function writeCarFile(
	duplex: Pick<
		Duplex<AsyncGenerator<Uint8ArrayList | Uint8Array<ArrayBufferLike>>>,
		"sink"
	>,
	exporter: Pick<Car, "export">,
	cid: CID,
	options: AbortOptions = {},
): Promise<void> {
	await duplex.sink(
		exporter.export(cid, {
			...options,
			exporter: new UnixFSExporter(),
		}),
	);
}

export async function zzzync(
	stream: Stream,
	exporter: Pick<Car, "export">,
	libp2pKey: Libp2pKey,
	record: IPNSRecord,
	cid: CID,
	options: AbortOptions = {},
): Promise<void> {
	const log = logger(`${PUSH_NAMESPACE}:${stream.id}`);

	log("starting zzzync");

	const bs = byteStream(stream);

	try {
		log.trace("writing ipns key");
		await writeIpnsMultihash(bs, libp2pKey.multihash);
		log("wrote ipns key");
	} catch (e) {
		log.error("failed while writing ipns key");
		throw e;
	}

	try {
		log.trace("writing ipns record");
		await writeIpnsRecord(bs, record);
		log("wrote ipns record");
	} catch (e) {
		log.error("failed while writing ipns record");
		throw e;
	}

	bs.unwrap();
	const duplex = messageStreamToDuplex(stream);

	try {
		log.trace("writing car file");
		await writeCarFile(duplex, exporter, cid, options);
		log("wrote car file");
	} catch (e) {
		log.error("failed while writing car file");
		throw e;
	}

	log.trace("waiting for remote to close write");
	await raceSignal(
		new Promise((resolve) =>
			stream.addEventListener("remoteCloseWrite", resolve, { once: true }),
		),
		options.signal,
	);
}

async function readByte(bs: ByteStream<Stream>): Promise<number> {
	const [byte] = await bs.read({ bytes: 1 });

	// biome-ignore lint/style/noNonNullAssertion: bs.read would throw if it couldn't return a byte
	return byte![0]!; // byte stream will return 1 byte or throw
}

export async function readVarint(bs: ByteStream<Stream>): Promise<number> {
	let byte = await readByte(bs);
	const varintBytes: number[] = [byte];

	while (byte & 0x80) {
		byte = await readByte(bs);
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
): Promise<[T, Uint8ArrayList]> {
	const n = await readVarint(bs);

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
): Promise<IpnsMultihash> {
	let [code, digest] = await readVarintPrefixed(bs, validateIpnsCode);

	if (code === CODEC_IDENTITY) {
		const [, _digest] = await readVarintPrefixed(bs, () => {});
		digest = _digest;
	}

	return Digest.create(code, digest.subarray());
}

export async function readIpnsRecord(
	bs: ByteStream<Stream>,
	ipnsMultihash: IpnsMultihash,
): Promise<IPNSRecord> {
	const recordLength = await readVarint(bs);
	const marshalledRecord = (await bs.read({ bytes: recordLength })).subarray();

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
	maxLength?: number;
}

export async function* readCarFile(
	source: AsyncGenerator<Uint8ArrayList | Uint8Array>,
	expectedRoot: CID<unknown, typeof CODEC_DAG_PB, number, 1>,
	// options: ReadCarFileOptions = {},
): AsyncGenerator<Block> {
	// const maxLength = options.maxLength ?? Infinity;
	const car = await CarBlockIterator.fromIterable(normalizeUint8Array(source));

	const [root] = await car.getRoots();

	if (root == null || !root.equals(expectedRoot)) {
		throw new Error("ERR_UNEXPECTED_ROOT");
	}

	yield* car;

	// TODO: only support DFS Car streams with duplicates.
	// let length = 0;
	// const references = new Set<string>(root.toString());
	// for await (const { cid, bytes } of car) {
	// 	length += bytes.length;
	// 	if (length >= maxLength) {
	// 		throw new Error("ERR_MAX_CAR_SIZE_EXCEEDED");
	// 	}

	// 	if (!references.has(cid.toString())) {
	// 		throw new Error("ERR_UNREFERENCED_BLOCK");
	// 	}

	// 	if (cid.code === CODEC_RAW) {
	// 		yield { bytes, cid };
	// 		continue;
	// 	}

	// 	if (cid.code !== CODEC_DAG_PB) {
	// 		throw new Error("ERR_UNSUPPORTED_CODEC");
	// 	}

	// 	// couldn't find where data was checked against cid in car decoder or importer
	// 	// otherwise this could be a createUnsafe call
	// 	const block = await create({ bytes, cid, codec: DagPB, hasher: sha256 });
	// 	for (const [_, link] of block.links()) {
	// 		references.add(link.toString());
	// 	}

	// 	yield block;
	// }
}

export type AllowFn = (
	ipnsMultihash: IpnsMultihash,
) => Promise<boolean> | boolean;

export interface CreateHandlerOptions extends ReadCarFileOptions {
	allow?: AllowFn;
}

export const createHandler =
	(
		ipns: IPNS,
		importer: Pick<Car, "import">,
		pins: Pins,
		options: CreateHandlerOptions = {},
	): StreamHandler =>
	async (stream: Stream): Promise<void> => {
		const log = logger(`${HANDLER_NAMESPACE}:${stream.id}`);

		try {
			log("new stream");

			const bs = byteStream(stream);

			let ipnsMultihash: IpnsMultihash;
			try {
				log.trace("reading ipns key from stream");
				ipnsMultihash = await readIpnsMultihash(bs);
			} catch (e) {
				log.error("failed while reading ipns key from stream");
				throw e;
			}
			log(`reading ipns key`, ipnsMultihash);

			if (options.allow && !(await options.allow(ipnsMultihash))) {
				const error = new Error("ipns key not allowed");
				log.error(error.message);
				throw error;
			}

			let remoteRecord: IPNSRecord;
			try {
				log.trace("reading ipns record from stream");
				remoteRecord = await readIpnsRecord(bs, ipnsMultihash);
			} catch (e) {
				log.error("failed while reading ipns record from stream");
				throw e;
			}
			log("read ipns record");

			let localRecord: IPNSRecord | undefined;
			let localRecordValue: CID | undefined;
			try {
				log.trace("resolving local record for ipns key");
				localRecord = await ipns
					.resolve(ipnsMultihash, { offline: true })
					.then((result) => result.record)
					.catch((e) => {
						if (
							e instanceof Error &&
							(e.name === "RecordNotFoundError" ||
								e.name === "RecordsFaileValidationError")
						) {
							return undefined;
						} else {
							throw e;
						}
					});
				try {
					localRecordValue = parseRecordValue(localRecord?.value ?? "");
				} catch {
					localRecordValue = undefined;
				}
			} catch (e) {
				log.error("failed while resolving local record");
				throw e;
			}

			if (localRecord) {
				log.trace("found a local record");
				if (localRecord.sequence > remoteRecord.sequence) {
					const error = new Error(
						"local record sequence is > received record's sequece",
					);
					log.error(error.message);
					throw error;
				}
			} else {
				log.trace("no local record found");
			}

			log("received record has value %s", remoteRecord.value);
			const value = parseRecordValue(remoteRecord.value);

			// if (value.equals(localRecordValue) && await pins.isPinned(value)) {
			// 	log('record value is already pinned, closing before car stream')
			// 	await Promise.all(
			// 		ipns.routers
			// 			.slice(0, 1)
			// 			.map((r) =>
			// 				r.put(
			// 					multihashToIPNSRoutingKey(ipnsMultihash),
			// 					marshalIPNSRecord(remoteRecord),
			// 				),
			// 			),
			// 	);
			// 	await stream.close();
			// 	return;
			// }

			bs.unwrap();
			const { source } = messageStreamToDuplex(stream);

			try {
				log.trace("importing car stream");
				// the write side should be closed after import completes
				await importer.import({
					blocks: () => readCarFile(source, value),
				});
				log("imported car stream");
			} catch (e) {
				log.error("failed while reading car stream");
				throw e;
			}

			const peerId = peerIdFromMultihash(ipnsMultihash);

			if (peerId.type === "url") {
				const error = new Error("url peer id not supported");
				log.error(error.message);
				throw error;
			}

			const libp2pKey = peerId.toCID();

			log.trace("pinning", value);
			await pin(pins, libp2pKey, value);
			log("pinned", value);

			log.trace("closing stream");
			await stream.close();
			log("closed stream");

			// then republish record
			// ipns.republish(ipnsMultihash, { record: remoteRecord, force: true }),
			const routingKey = multihashToIPNSRoutingKey(ipnsMultihash);
			const marshaledRecord = marshalIPNSRecord(remoteRecord);
			log("republishing records to routers");
			void ipns.routers.map(async (r) => {
				// only republishes one time, waiting for ipns.republish feature
				await r.put(routingKey, marshaledRecord);
			});

			if (localRecordValue != null) {
				log("unpinning old record value", localRecordValue);
				await unpin(pins, libp2pKey, localRecordValue);
			}
		} catch (e) {
			log.error("failed while processing stream - %e", e);
			if (e instanceof Error) {
				stream.abort(e);
			} else {
				throw e;
			}
		}
	};
