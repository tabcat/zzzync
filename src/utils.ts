import { CID } from "multiformats/cid";
import { CODEC_DAG_PB, CODEC_RAW, IPFS_PREFIX } from "./constants.js";
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
