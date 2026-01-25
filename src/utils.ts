import * as dagPb from "@ipld/dag-pb";
import type { BlockCodec, MultihashHasher } from "multiformats";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
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
		getHasher(cid.multihash.code);
		if (cid.code === CODEC_DAG_PB || cid.code === CODEC_RAW) {
			return cid as UnixFsCID;
		}
	} catch {}
	return null;
}

export type SupportedCodecs = typeof CODEC_DAG_PB & typeof CODEC_RAW;

export function getCodec(code: number): BlockCodec<number, unknown> {
	switch (code) {
		case dagPb.code:
			return dagPb;
		default:
			return raw;
	}
}

export type SupportedHasherCodes = typeof CODEC_SHA2_256;

export function getHasher(code: number): MultihashHasher {
	switch (code) {
		case sha256.code:
			return sha256;
		default:
			throw new Error("Unsupported hash code.");
	}
}
