export const CID_VERSION_1 = 0x01;
export const CODEC_IDENTITY = 0x00;
export const CODEC_SHA2_256 = 0x12;
export const CODEC_RAW = 0x55;
export const CODEC_DAG_PB = 0x70;
export const CODEC_DAG_CBOR = 0x71;
export const CODEC_LIBP2P_KEY = 0x72;
export const IPFS_PREFIX = "/ipfs/";
export const IPNS_PREFIX = "/ipns/";
export const ZZZYNC = "zzzync";
export const ZZZYNC_PUSH = `/${ZZZYNC}/push`;
export const ZZZYNC_PUSH_VERSION = "1.0.0";
export const ZZZYNC_PUSH_PROTOCOL_ID = `${ZZZYNC_PUSH}/${ZZZYNC_PUSH_VERSION}`;

/** IPNS record size cap from the IPNS spec. */
export const MAX_IPNS_RECORD_SIZE = 10 * 1024;
/** Max bytes for an identity-wrapped IPNS public key multihash digest. */
export const MAX_IPNS_KEY_BYTES = 64;
/** Default total CAR size cap for a received push. */
export const DEFAULT_MAX_CAR_BYTES = 5 * 1024 * 1024;
/** Max size of a single block in a received CAR. */
export const MAX_BLOCK_BYTES = 2 * 1024 * 1024;
/** Default cap on the number of blocks in a received CAR. */
export const DEFAULT_MAX_BLOCK_COUNT = 10_000;
/** Default per-step deadline (ms) for each dialer read/write step. */
export const DEFAULT_WRITE_TIMEOUT_MS = 10_000;
/** Default deadline (ms) the dialer waits for the handler to close. */
export const DEFAULT_ACK_TIMEOUT_MS = 15_000;
/** Default handler idle timeout (ms): abort if no bytes arrive for this long. */
export const DEFAULT_IDLE_TIMEOUT_MS = 10_000;
/** Default handler total deadline (ms): abort a stream after this wall-clock cap regardless of activity, bounding slow-drip. */
export const DEFAULT_MAX_STREAM_MS = 5 * 60 * 1000;
