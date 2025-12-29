import { type Car, UnixFSExporter } from "@helia/car";
import type { Pins } from "@helia/interface";
import type { IPNS } from "@helia/ipns";
import { type Block, CarBlockIterator } from "@ipld/car/iterator";
import * as DagPB from "@ipld/dag-pb";
import type { AbortOptions, Stream, StreamHandler } from "@libp2p/interface";
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
import type { CID, MultihashDigest } from "multiformats";
import { create } from "multiformats/block";
import * as Digest from "multiformats/hashes/digest";
import { sha256 } from "multiformats/hashes/sha2";
import { raceSignal } from "race-signal";
import * as varint from "uint8-varint";
import { isUint8ArrayList, Uint8ArrayList } from "uint8arraylist";
import {
	CODEC_DAG_PB,
	CODEC_IDENTITY,
	CODEC_RAW,
	CODEC_SHA2_256,
} from "./constants.js";
import { pin, unpin } from "./pins.js";
import { parseRecordValue } from "./utils.js";

export type IpnsKey = MultihashDigest<
	typeof CODEC_IDENTITY | typeof CODEC_SHA2_256
>;

export async function writeVarintPrefixed(
	bs: ByteStream<Stream>,
	bytes: Uint8Array,
): Promise<void> {
	return bs.write(new Uint8ArrayList(varint.encode(bytes.length), bytes));
}

async function writeIpnsKey(
	bs: ByteStream<Stream>,
	ipnsKey: IpnsKey,
): Promise<void> {
	return bs.write(ipnsKey.bytes);
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
	ipnsKey: IpnsKey,
	record: IPNSRecord,
	cid: CID,
	options: AbortOptions = {},
): Promise<void> {
	const bs = byteStream(stream);

	await writeIpnsKey(bs, ipnsKey);
	await writeIpnsRecord(bs, record);

	bs.unwrap();
	const duplex = messageStreamToDuplex(stream);

	await writeCarFile(duplex, exporter, cid, options);

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

async function readVarint(bs: ByteStream<Stream>): Promise<number> {
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

export type VarintGuard<T extends number = number> = (n: number) => asserts n is T;

export async function readVarintPrefixed<T extends number>(
	bs: ByteStream<Stream>,
	varintGuard: VarintGuard<T>,
): Promise<[T, Uint8ArrayList]> {
	const n = await readVarint(bs);

	varintGuard(n);

	return [n as T, await bs.read({ bytes: n })];
}

async function readIpnsKey(bs: ByteStream<Stream>): Promise<IpnsKey> {
	const validateIpnsCode: VarintGuard<
		typeof CODEC_IDENTITY | typeof CODEC_SHA2_256
	> = (n: number) => {
		if (n !== CODEC_IDENTITY && n !== CODEC_SHA2_256) {
			throw new Error("UNSUPPORTED_IPNS_KEY");
		}
	};

	const [code, digest] = await readVarintPrefixed(bs, validateIpnsCode);
	return Digest.create(code, digest.subarray());
}

async function readIpnsRecord(
	bs: ByteStream<Stream>,
	ipnsKey: IpnsKey,
): Promise<IPNSRecord> {
	const recordLength = await readVarint(bs);
	const marshalledRecord = (await bs.read({ bytes: recordLength })).subarray();

	await ipnsValidator(multihashToIPNSRoutingKey(ipnsKey), marshalledRecord);

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
	options: ReadCarFileOptions = {},
): AsyncGenerator<Block> {
	const maxLength = options.maxLength ?? Infinity;
	const car = await CarBlockIterator.fromIterable(normalizeUint8Array(source));

	const [root] = await car.getRoots();

	if (root == null || !root.equals(expectedRoot)) {
		throw new Error("ERR_UNEXPECTED_ROOT");
	}

	// TODO: only support DFS Car streams with duplicates.
	let length = 0;
	const references = new Set<string>(root.toString());
	for await (const { cid, bytes } of car) {
		length += bytes.length;
		if (length >= maxLength) {
			throw new Error("ERR_MAX_CAR_SIZE_EXCEEDED");
		}

		if (!references.has(cid.toString())) {
			throw new Error("ERR_UNREFERENCED_BLOCK");
		}

		if (cid.code === CODEC_RAW) {
			yield { bytes, cid };
			continue;
		}

		if (cid.code !== CODEC_DAG_PB) {
			throw new Error("ERR_UNSUPPORTED_CODEC");
		}

		// couldn't find where data was checked against cid in car decoder or importer
		// otherwise this could be a createUnsafe call
		const block = await create({ bytes, cid, codec: DagPB, hasher: sha256 });
		for (const [_, link] of block.links()) {
			references.add(link.toString());
		}

		yield block;
	}
}

export type AllowFn = (ipnsKey: IpnsKey) => Promise<boolean> | boolean;

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
		const bs = byteStream(stream);

		const ipnsKey = await readIpnsKey(bs);

		if (options.allow && !(await options.allow(ipnsKey))) {
			stream.abort(new Error("RECORD_KEY_NO_ACCESS"));
			return;
		}

		const remoteRecord = await readIpnsRecord(bs, ipnsKey);
		const localRecord = await ipns
			.resolve(ipnsKey, { offline: true })
			.then((result) => result.record)
			.catch(() => undefined);

		if (localRecord && localRecord.sequence > remoteRecord.sequence) {
			stream.abort(new Error("RECORD_OBSOLETE"));
			return;
		}

		const root = parseRecordValue(remoteRecord.value);

		bs.unwrap();
		const { source } = messageStreamToDuplex(stream);

		// the write side should be closed after import completes
		await importer.import({
			blocks: () => readCarFile(source, root, options),
		});

		// do these in serial just to be safe

		// pin first
		await pin(pins, ipnsKey, root);

		// then republish record
		// ipns.republish(ipnsKey, { record: remoteRecord, force: true }),
		const routingKey = multihashToIPNSRoutingKey(ipnsKey);
		const marshaledRecord = marshalIPNSRecord(remoteRecord);
		await Promise.all(
			ipns.routers.map(async (r) => {
				// only republishes one time, waiting for ipns.republish feature
				await r.put(routingKey, marshaledRecord);
			}),
		);

		// close stream after record is republished and data is pinned
		await stream.close();

		if (localRecord != null) {
			const prevRoot = parseRecordValue(localRecord.value);
			await unpin(pins, ipnsKey, prevRoot);
		}
	};
