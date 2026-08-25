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
/** Default per-step deadline (ms) for each dialer read/write step. */
export const DEFAULT_WRITE_TIMEOUT_MS = 10_000;
/** Default deadline (ms) the dialer waits for the handler to close. */
export const DEFAULT_ACK_TIMEOUT_MS = 15_000;
/** Default handler idle timeout (ms): abort if no bytes arrive for this long. */
export const DEFAULT_IDLE_TIMEOUT_MS = 10_000;
/** Default deadline (ms) for each application callback (allow.multihash, allow.record, onReceive). A hang guard, not a latency budget: it bounds the handler, not the callback, which keeps running. */
export const DEFAULT_RACE_TIMEOUT_MS = 30_000;
/** Default handler handshake deadline (ms): the handshake carries bounded, latency-bound data, so it gets a wall-clock cap of its own. */
export const DEFAULT_HANDSHAKE_TIMEOUT_MS = 30_000;
/** Default minimum bytes/sec a CAR transfer must sustain; makes holding a stream cost bandwidth in proportion to the time held. */
export const DEFAULT_MIN_BYTES_PER_SECOND = 1024;
/** Default window (ms) the throughput floor is sampled over. */
export const DEFAULT_RATE_WINDOW_MS = 5_000;
/** Default handler backstop (ms): abort a stream after this wall-clock cap, not reset by activity and cleared once the remote closes its write side. A configured throughput floor handles slow-drip, leaving this to stop a stream running forever. */
export const DEFAULT_MAX_STREAM_MS = 60 * 60 * 1000;
