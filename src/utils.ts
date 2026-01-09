import { CID } from "multiformats/cid";
import { CODEC_DAG_PB, IPFS_PREFIX } from "./constants.js";

export function parseRecordValue(
	value: string,
): CID<unknown, typeof CODEC_DAG_PB, number, 1> {
	if (!value.startsWith(IPFS_PREFIX)) {
		throw new TypeError('value is missing /ipfs/ prefix');
	}

	const cid = CID.parse(value.substring(IPFS_PREFIX.length));

	if (cid.code !== CODEC_DAG_PB) {
		throw new TypeError('value cid code is not dag-pb');
	}

	return cid as CID<unknown, typeof CODEC_DAG_PB, number, 1>;
}
