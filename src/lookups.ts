/**
 * Lookup functions for @libp2p/fetch service
 */

import type { LookupFunction } from "@libp2p/fetch";
import type { Blockstore } from "interface-blockstore";
import { type Datastore, Key } from "interface-datastore";
import { CID } from "multiformats/cid";
import {
	concat,
	fromString as uint8ArrayFromString,
	toString as uint8ArrayToString,
} from "uint8arrays";
import {
	CID_VERSION_1,
	CODEC_RAW,
	IPFS_PREFIX,
} from "./constants.js";

// @helia/ipns localStore record key
const DHT_RECORD_PREFIX = "/dht/record/";
function dhtRoutingKey(key: Uint8Array): Key {
	return new Key(DHT_RECORD_PREFIX + uint8ArrayToString(key, "base32"), false);
}

export interface IpnsRecordLookupComponents {
	datastore: Datastore;
}

export const createIpnsRecordLookup =
	(components: IpnsRecordLookupComponents): LookupFunction =>
	async (routingKey) => {
		const { datastore } = components;
		try {
			return datastore.get(dhtRoutingKey(routingKey));
		} catch (e) {
			if (e instanceof Error && e.name === "NotFoundError") {
				return undefined;
			}
			throw e;
		}
	};

const ipfsPrefixBytes = uint8ArrayFromString(IPFS_PREFIX);

export const fetchKeyFromCid = (cid: CID): Uint8Array =>
	concat([ipfsPrefixBytes, cid.multihash.bytes]);

const fetchKeyToCid = (key: Uint8Array): CID =>
	CID.decode(
		concat([
			// cidv1 raw codec; blockstores should only use multihash
			new Uint8Array([CID_VERSION_1, CODEC_RAW]),
			key.slice(ipfsPrefixBytes.length),
		]),
	);

interface BlockstoreLookupComponents {
	blockstore: Blockstore;
}

export const createBlockstoreLookup =
	(components: BlockstoreLookupComponents): LookupFunction =>
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
