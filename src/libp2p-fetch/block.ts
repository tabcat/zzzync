import type { Fetch, LookupFunction } from "@libp2p/fetch";
import type { PeerId } from "@libp2p/interface";
import type { Blockstore } from "interface-blockstore";
import type { AbortOptions } from "interface-store";
import { CID } from "multiformats/cid";
import { concat, fromString } from "uint8arrays";
import { CID_VERSION_1, CODEC_RAW, IPFS_PREFIX } from "../constants.js";

const ipfsPrefixBytes = fromString(IPFS_PREFIX);

const fetchKeyFromCid = (cid: CID): Uint8Array =>
	concat([ipfsPrefixBytes, cid.multihash.bytes]);

export const fetchBlock = (
	fetch: Fetch["fetch"],
	peerId: PeerId,
	cid: CID,
	options: AbortOptions = {},
): Promise<Uint8Array | undefined> =>
	fetch(peerId, fetchKeyFromCid(cid), options);

const fetchKeyToCid = (key: Uint8Array): CID =>
	CID.decode(
		concat([
			// cidv1 raw codec; blockstores should only use multihash
			new Uint8Array([CID_VERSION_1, CODEC_RAW]),
			key.slice(ipfsPrefixBytes.length),
		]),
	);

export interface BlockLookupComponents {
	blockstore: Blockstore;
}

export const createBlockLookup =
	(components: BlockLookupComponents): LookupFunction =>
	async (multihash) => {
		const { blockstore } = components;
		try {
			const list: Uint8Array[] = [];
			for await (const bytes of blockstore.get(fetchKeyToCid(multihash))) {
				list.push(bytes);
			}
			return concat(list);
		} catch (e) {
			if (e instanceof Error && e.name === "NotFoundError") {
				return undefined;
			}
			throw e;
		}
	};
