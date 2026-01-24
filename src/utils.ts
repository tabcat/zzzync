import type { MultihashHasher } from "multiformats";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import {
	CODEC_DAG_PB,
	CODEC_RAW,
	type CODEC_SHA2_256,
	IPFS_PREFIX,
} from "./constants.js";
import type { UnixFsCID } from "./interface.js";

export function parsedRecordValue(value: string): UnixFsCID | null {
	try {
		const cid = CID.parse(value.substring(IPFS_PREFIX.length));
		if (cid.code === CODEC_DAG_PB || cid.code === CODEC_RAW) {
			return cid as UnixFsCID;
		}
	} catch {}
	return null;
}

export function getHasher(code: typeof CODEC_SHA2_256): MultihashHasher {
	switch (code) {
		case sha256.code:
			return sha256;
		default:
			throw new Error("Unsupported hash code.");
	}
}
