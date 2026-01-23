import { CID } from "multiformats/cid";
import { IPFS_PREFIX } from "./constants.js";

export function parseRecordValue(value: string): CID {
	if (!value.startsWith(IPFS_PREFIX)) {
		throw new TypeError("value is missing /ipfs/ prefix");
	}

	const cid = CID.parse(value.substring(IPFS_PREFIX.length));

	return cid;
}
