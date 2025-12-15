import type { Car, CarComponents } from "@helia/car";
import type { Fetch } from "@libp2p/fetch";
import type { Libp2p, PeerId, PublicKey } from "@libp2p/interface";
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
import { createInitiator } from "./initiator.js";
import type { Blockfetcher, IpnsKey, IpnsRecordFetcher } from "./interface.js";
import { fetchKeyFromCid } from "./lookups.js";

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
		options: AbortOptions,
	): Promise<IPNSRecord> {
		const marshalledRecord = await fetch(
			peerId,
			multihashToIPNSRoutingKey(ipnsKey),
			options,
		);

		if (marshalledRecord === undefined) {
			throw new NotFoundError();
		}

		return unmarshalIPNSRecord(marshalledRecord);
	}

	return { get };
};

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
		options: AbortOptions,
	): AwaitGenerator<Uint8Array> {
		const bytes = await fetch(peerId, fetchKeyFromCid(cid), options);

		if (bytes === undefined) {
			throw new NotFoundError();
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

export const createZzzyncUploader = (
	components: ZzzyncUploaderComponents,
	peerId: PeerId,
	car: Car,
) => {
	async function upload(
		publicKey: PublicKey,
		record: IPNSRecord,
		options: AbortOptions,
	): Promise<void> {
		const stream = await components.libp2p.dialProtocol(
			peerId,
			ZZZYNC_PROTOCOL_ID,
			options,
		);
		const initiator = createInitiator(car, publicKey.toMultihash(), record);

		await initiator(stream);
	}

	return { upload };
};
