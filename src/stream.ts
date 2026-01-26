import { type Car, UnixFSExporter } from "@helia/car";
import type { Pins } from "@helia/interface";
import { type IPNS, ipnsSelector } from "@helia/ipns";
import { type Block, CarBlockIterator } from "@ipld/car/iterator";
// import * as DagPB from "@ipld/dag-pb";
import type {
	AbortOptions,
	Connection,
	Stream,
	StreamHandler,
} from "@libp2p/interface";
import { logger } from "@libp2p/logger";
import { peerIdFromMultihash } from "@libp2p/peer-id";
import {
	type ByteStream,
	byteStream,
	type Filter,
	messageStreamToDuplex,
} from "@libp2p/utils";
import { anySignal } from "any-signal";
import {
	type IPNSRecord,
	marshalIPNSRecord,
	multihashToIPNSRoutingKey,
	unmarshalIPNSRecord,
} from "ipns";
import { ipnsValidator } from "ipns/validator";
import type { Duplex } from "it-stream-types";
import type { CID } from "multiformats";
import { create } from "multiformats/block";
// import { create } from "multiformats/block";
import * as Digest from "multiformats/hashes/digest";
// import { sha256 } from "multiformats/hashes/sha2";
import { raceSignal } from "race-signal";
import * as varint from "uint8-varint";
import { isUint8ArrayList, Uint8ArrayList } from "uint8arraylist";
import {
	CODEC_DAG_PB,
	CODEC_IDENTITY,
	CODEC_SHA2_256,
	ZZZYNC,
} from "./constants.js";
import type { IpnsMultihash, Libp2pKey, UnixFsCID } from "./interface.js";
import { pin, unpin } from "./pins.js";
import { getCodec, getHasher, parsedRecordValue } from "./utils.js";

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
	const references = new Set<string>();
	const blockFilter: Filter = {
		add: (bytes) => references.add(bytes.toString()),
		has: (bytes) => references.has(bytes.toString()),
	};
	await duplex.sink(
		exporter.export(cid, {
			...options,
			blockFilter, // dedupe
			exporter: new UnixFSExporter(),
			offline: true,
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

	const controller = new AbortController();
	stream.addEventListener("close", (e) => controller.abort(e.error), {
		once: true,
	});
	const signal = anySignal([controller.signal, options.signal]);

	const routine = async () => {
		log("starting zzzync");

		const bs = byteStream(stream);

		try {
			await writeIpnsMultihash(bs, libp2pKey.multihash);
			log("wrote ipns key");
		} catch (e) {
			log.error("failed while writing ipns key");
			throw e;
		}

		try {
			await writeIpnsRecord(bs, record);
			log("wrote ipns record");
		} catch (e) {
			log.error("failed while writing ipns record");
			throw e;
		}

		bs.unwrap();
		const duplex = messageStreamToDuplex(stream);

		try {
			await writeCarFile(duplex, exporter, cid, options);

			log("wrote car file");
		} catch (e) {
			log.error("failed while writing car file");
			throw e;
		}

		log("waiting for remote to close write");
		await new Promise((resolve) =>
			stream.addEventListener("remoteCloseWrite", resolve, { once: true }),
		);
	};

	try {
		await raceSignal(routine(), signal);
	} finally {
		signal.clear()
	}
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
	} else {
		throw new Error("Expected identity multihash.");
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
	async (stream: Stream, connection: Connection): Promise<void> => {
		const log = logger(`${HANDLER_NAMESPACE}:${stream.id}`);

		try {
			log("new stream from %s", connection.remotePeer);

			const bs = byteStream(stream);

			let ipnsMultihash: IpnsMultihash;
			try {
				ipnsMultihash = await readIpnsMultihash(bs);
			} catch (e) {
				log.error("failed while reading ipns key from stream");
				throw e;
			}
			log(`read ipns key %s`, ipnsMultihash);

			const peerId = peerIdFromMultihash(ipnsMultihash);

			if (peerId.type === "RSA" || peerId.type === "url") {
				const error = new Error(`peer id type "${peerId.type}" not supported`);
				log.error(error.message);
				throw error;
			}

			if (options.allow && !(await options.allow(ipnsMultihash))) {
				const error = new Error("ipns key not allowed");
				log.error(error.message);
				throw error;
			}

			let remoteRecord: IPNSRecord;
			try {
				remoteRecord = await readIpnsRecord(bs, ipnsMultihash);
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
				const resolved = await ipns.resolve(ipnsMultihash, { offline: true });
				localRecord = resolved.record;
				log(
					"found local record for %s with value %s",
					ipnsMultihash,
					localRecord.value,
				);
			} catch (e) {
				if (
					e instanceof Error &&
					(e.name === "RecordNotFoundError" ||
						e.name === "RecordsFaileValidationError")
				) {
					localRecord = undefined;
					log("no local record found for %s", ipnsMultihash);
				} else {
					log.error("failed while resolving local record");
					throw e;
				}
			}

			// check that localRecord is not better than remoteRecord
			if (localRecord) {
				const records: IPNSRecord[] = [remoteRecord, localRecord];
				const selected = ipnsSelector(
					multihashToIPNSRoutingKey(ipnsMultihash),
					records.map(marshalIPNSRecord),
				);

				if (selected !== 0) {
					const error = new Error(
						"Record received from remote was worse than local record.",
					);
					log.error(error);
					throw error;
				}
			}

			bs.unwrap();
			const { source } = messageStreamToDuplex(stream);

			try {
				log("importing car stream");
				// the write side should be closed after import completes
				await importer.import({
					blocks: () => readCarFile(source, value, options),
				});
				log("finished importing car stream");
			} catch (e) {
				log.error("failed while reading car stream");
				throw e;
			}

			const libp2pKey = peerId.toCID();
			await pin(pins, libp2pKey, value);
			log("pinned %s for pinner %s", value, libp2pKey);

			// then republish record
			// ipns.republish(ipnsMultihash, { record: remoteRecord, force: true }),
			const routingKey = multihashToIPNSRoutingKey(ipnsMultihash);
			const marshaledRecord = marshalIPNSRecord(remoteRecord);
			ipns.routers.map(async (r) => {
				// only republishes one time, waiting for ipns.republish feature
				r.put(routingKey, marshaledRecord);
			});
			log("republishing records to routers");

			await stream.close();
			log("closed stream");

			const localRecordValue = parsedRecordValue(localRecord?.value ?? "");
			if (localRecordValue != null && !localRecordValue.equals(value)) {
				try {
					await unpin(pins, libp2pKey, localRecordValue);
					log("unpinned %s for pinner %s", localRecordValue, libp2pKey);
				} catch (e) {
					if (e instanceof Error && e.name === "NotFoundError") {
						log("tried to unpin cid that was not pinned!");
						log.error(e);
					} else {
						throw e;
					}
				}
			} else {
				log("value unchanged, skipping unpin")
			}
		} catch (e) {
			log.error("failed while processing stream - %e", e);
			if (e instanceof Error) {
				stream.abort(e);
			} else {
				stream.abort(new Error(String(e)));
			}
		}
	};
