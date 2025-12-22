import type { Car } from "@helia/car";
import type { Pins } from "@helia/interface";
import type { IPNS } from "@helia/ipns";
import { type Block, CarBlockIterator } from "@ipld/car/iterator";
import * as DagPB from "@ipld/dag-pb";
import type { Stream, StreamHandler } from "@libp2p/interface";
import {
	type ByteStream,
	byteStream,
	messageStreamToDuplex,
} from "@libp2p/utils";
import {
	type IPNSRecord,
	multihashToIPNSRoutingKey,
	unmarshalIPNSRecord,
} from "ipns";
import { ipnsValidator } from "ipns/validator";
import type { CID } from "multiformats";
import { create } from "multiformats/block";
import * as Digest from "multiformats/hashes/digest";
import { sha256 } from "multiformats/hashes/sha2";
import * as varint from "uint8-varint";
import { isUint8ArrayList, type Uint8ArrayList } from "uint8arraylist";
import {
	CODEC_DAG_PB,
	CODEC_IDENTITY,
	CODEC_RAW,
	CODEC_SHA2_256,
} from "./constants.js";
import type { AllowFn, IpnsKey } from "./interface.js";
import { parseRecordValue } from "./utils.js";

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

export async function readIpnsKey(bs: ByteStream<Stream>): Promise<IpnsKey> {
	const code = await readVarint(bs);

	if (code !== CODEC_IDENTITY && code !== CODEC_SHA2_256) {
		throw new Error("UNSUPPORTED_IPNS_KEY");
	}

	const digestLength = await readVarint(bs);
	const digest = (await bs.read({ bytes: digestLength })).subarray();

	return Digest.create(code, digest);
}

export async function readIpnsRecord(
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

interface ReadCarStreamOptions {
	maxLength?: number;
}

export async function* readCarStream(
	source: AsyncGenerator<Uint8ArrayList | Uint8Array>,
	expectedRoot: CID<unknown, typeof CODEC_DAG_PB, number, 1>,
	options: ReadCarStreamOptions = {},
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

async function pin (pins: Pins, pinner: IpnsKey, root: CID): Promise<void> {
	try {
		for await (const _ of pins.add(root, { metadata: { [pinner.toString()]: Date.now() }})) {}
	} catch (e) {
		if (e instanceof Error && e.name === 'AlreadyPinnedError') {
			const { metadata } = await pins.get(root)
			metadata[pinner.toString()] = true
			await pins.setMetadata(root, metadata)
		} else {
			throw e;
		}
	}
}

async function unpin (pins: Pins, pinner: IpnsKey, prevRoot: CID): Promise<void> {
	const { metadata } = await pins.get(prevRoot)

	if (metadata[pinner.toString()]) {
		delete metadata[pinner.toString()]
	}

	if (Object.keys(metadata).length > 0) {
		await pins.setMetadata(prevRoot, metadata)
	} else {
		for await (const _ of pins.rm(prevRoot)) {}
	}
}

export interface CreateHandlerOptions extends ReadCarStreamOptions {
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
			blocks: () => readCarStream(source, root, options),
		});

		// do these in serial just to be safe
		await pin(pins, ipnsKey, root)
		// ipns.republish(ipnsKey, { record: remoteRecord, force: true }),

		await stream.close();

		if (localRecord != null) {
			const prevRoot = parseRecordValue(localRecord.value)
			await unpin(pins, ipnsKey, prevRoot)
		}
	};
