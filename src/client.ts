import { type CarComponents, car } from "@helia/car";
import type { Fetch } from "@libp2p/fetch";
import type { Libp2p, PeerId, PublicKey } from "@libp2p/interface";
import { peerIdFromMultihash } from "@libp2p/peer-id";
import type { Blockstore } from "interface-blockstore";
import {
	type AbortOptions,
	type AwaitGenerator,
	NotFoundError,
} from "interface-store";
import {
	type IPNSRecord,
	multihashToIPNSRoutingKey,
	unmarshalIPNSRecord,
} from "ipns";
import type { CID } from "multiformats/cid";
import { ZZZYNC_PROTOCOL_ID } from "./constants.js";
import { fetchBlock } from "./libp2p-fetch/block.js";
import { type IpnsKey, zzzync } from "./stream.js";
import { parseRecordValue } from "./utils.js";

export interface IpnsRecordFetcher {
	get(ipnsKey: IpnsKey, options: AbortOptions): Promise<IPNSRecord>;
}

export interface IpnsRecordFetcherComponents {
	libp2p: {
		services: {
			fetch: Fetch;
		};
	};
}

export const createIpnsRecordFetcher = (
	components: IpnsRecordFetcherComponents,
	peerId: PeerId,
): IpnsRecordFetcher => {
	const { fetch } = components.libp2p.services.fetch;

	async function get(
		ipnsKey: IpnsKey,
		options: AbortOptions = {},
	): Promise<IPNSRecord> {
		const cid = peerIdFromMultihash(ipnsKey).toCID();
		const marshalledRecord = await fetch(
			peerId,
			multihashToIPNSRoutingKey(ipnsKey),
			options,
		);

		if (marshalledRecord == null) {
			throw new NotFoundError(
				`Did not find record for ${cid} on peer ${peerId}`,
			);
		}

		return unmarshalIPNSRecord(marshalledRecord);
	}

	return { get };
};

export type Blockfetcher = Pick<Blockstore, "get">;

export interface BlockFetcherComponents {
	libp2p: {
		services: {
			fetch: Fetch;
		};
	};
}

export const createBlockFetcher = (
	components: BlockFetcherComponents,
	peerId: PeerId,
): Blockfetcher => {
	const { fetch } = components.libp2p.services.fetch;

	async function* get(
		cid: CID,
		options: AbortOptions = {},
	): AwaitGenerator<Uint8Array> {
		const bytes = await fetchBlock(fetch, peerId, cid, options);

		if (bytes === undefined) {
			throw new NotFoundError(
				`Did not find content for ${cid} on peer ${peerId}`,
			);
		}

		yield bytes;
	}

	return { get };
};

export interface ZzzyncUploaderComponents extends CarComponents {
	libp2p: {
		dialProtocol: Libp2p["dialProtocol"];
	};
}

export interface ZzzyncUploader {
	upload(
		publicKey: PublicKey,
		record: IPNSRecord,
		options?: AbortOptions,
	): Promise<void>;
}

export const createZzzyncUploader = (
	components: ZzzyncUploaderComponents,
	peerId: PeerId,
): ZzzyncUploader => {
	const { libp2p } = components;
	const exporter = car(components);

	async function upload(
		publicKey: PublicKey,
		record: IPNSRecord,
		options: AbortOptions,
	): Promise<void> {
		const stream = await libp2p.dialProtocol(
			peerId,
			ZZZYNC_PROTOCOL_ID,
			options,
		);

		const cid = parseRecordValue(record.value);
		await zzzync(
			stream,
			exporter,
			publicKey.toMultihash(),
			record,
			cid,
			options,
		);
	}

	return { upload };
};

export interface ZzzyncClient {
	blocks: Blockfetcher;
	records: IpnsRecordFetcher;
	uploader: ZzzyncUploader;
}

export type ClientComponents = IpnsRecordFetcherComponents &
	BlockFetcherComponents &
	ZzzyncUploaderComponents;

export const createClient = (
	components: ClientComponents,
	peerId: PeerId,
): ZzzyncClient => {
	return {
		blocks: createBlockFetcher(components, peerId),
		records: createIpnsRecordFetcher(components, peerId),
		uploader: createZzzyncUploader(components, peerId),
	};
};
