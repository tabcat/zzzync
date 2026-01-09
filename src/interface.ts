import type { CID, MultihashDigest } from "multiformats/cid";
import type {
	CID_VERSION_1,
	CODEC_IDENTITY,
	CODEC_LIBP2P_KEY,
	CODEC_SHA2_256,
} from "./constants.js";

/**
 * CID<0x1, 0x72, 0x00 | 0x12>
 */
export type Libp2pKey = CID<
	typeof CID_VERSION_1,
	typeof CODEC_LIBP2P_KEY,
	typeof CODEC_IDENTITY | typeof CODEC_SHA2_256
>;

/**
 * MultihashDigest<0x00 | 0x12>
 */
export type IpnsMultihash = MultihashDigest<
	typeof CODEC_IDENTITY | typeof CODEC_SHA2_256
>;
