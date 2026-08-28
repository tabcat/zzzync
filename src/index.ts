/**
 * @packageDocumentation
 *
 * A libp2p protocol for handing a signed dataset to another peer that can serve
 * it as a verifiable replica of the original publisher.
 *
 * A publisher proves it holds an IPNS key, then streams a signed IPNS record and
 * a CAR of its content to a handler. The handler verifies the signature and the
 * content, then hands the record to your application to pin and serve. The result
 * is a durable, verifiable copy that stays available even while the publisher is
 * offline.
 *
 * The CAR format sets no maximum of any kind, so every size limit is the
 * application's to choose. Leave them unset and zzzync caps nothing itself,
 * though each section and the header still fall under `@ipld/car`'s own
 * defaults; only the total is uncapped, bounded then by the handler's idle
 * timeout, its throughput floor and its backstop deadline.
 *
 * @example Receive pushes (handler)
 *
 * ```ts
 * import { car } from '@helia/car'
 * import { createZzzyncHandler, registerZzzyncHandler } from '@tabcat/zzzync/handler'
 *
 * const handler = createZzzyncHandler(
 *   helia.libp2p.peerId,
 *   car(helia),
 *   {
 *     // gate which keys may push, and which records to accept
 *     multihash: (key) => myAllowList.has(key.toCID().toString()),
 *     record: (name, record) => true,
 *   },
 *   async ({ name, record, pinner }) => {
 *     // record is signature-verified and its CAR fully validated;
 *     // pin the content, persist the record, then serve and announce it
 *   },
 *   {
 *     // size limits are yours to pick; unset means zzzync does not cap
 *     maxByteLength: 5 * 1024 * 1024,
 *     // the cap in force is min(maxByteLength, minBytesPerSecond * maxStreamMs),
 *     // so the default 1KiB/s floor would hold this to 3.52MiB; 2KiB/s makes
 *     // the declared 5MiB actually reachable, in ~43min
 *     minBytesPerSecond: 2048,
 *     maxBlockCount: 10_000,
 *     maxCarSectionSize: 2 * 1024 * 1024,
 *     maxCarHeaderSize: 1024,
 *   },
 * )
 *
 * const unregister = await registerZzzyncHandler(helia.libp2p, handler)
 * ```
 *
 * @example Push a dataset (dialer)
 *
 * ```ts
 * import { car } from '@helia/car'
 * import { ipns } from '@helia/ipns'
 * import { createSign } from '@tabcat/zzzync/challenge'
 * import { dialZzzync } from '@tabcat/zzzync/dialer'
 *
 * // publish locally, then push the signed record + content to a handler peer
 * const name = ipns(helia)
 * const { record, publicKey } = await name.publish(keyName, cid)
 *
 * await dialZzzync(
 *   helia.libp2p,
 *   handlerPeerId,
 *   car(helia),
 *   { record, publicKey },
 *   createSign(privateKey),
 * )
 * ```
 */
import * as c from "./constants.ts";

/**
 * Protocol identifiers, wire caps, and the defaults behind every optional
 * timing and size knob. Grouped rather than spread across two dozen top-level
 * exports, since almost nothing here is reached individually.
 */
export const constants = {
  ZZZYNC: c.ZZZYNC,
  ZZZYNC_PUSH: c.ZZZYNC_PUSH,
  ZZZYNC_PUSH_VERSION: c.ZZZYNC_PUSH_VERSION,
  ZZZYNC_PUSH_PROTOCOL_ID: c.ZZZYNC_PUSH_PROTOCOL_ID,

  IPFS_PREFIX: c.IPFS_PREFIX,
  IPNS_PREFIX: c.IPNS_PREFIX,

  CID_VERSION_1: c.CID_VERSION_1,
  CODEC_IDENTITY: c.CODEC_IDENTITY,
  CODEC_SHA2_256: c.CODEC_SHA2_256,
  CODEC_RAW: c.CODEC_RAW,
  CODEC_DAG_PB: c.CODEC_DAG_PB,
  CODEC_DAG_CBOR: c.CODEC_DAG_CBOR,
  CODEC_LIBP2P_KEY: c.CODEC_LIBP2P_KEY,

  MAX_IPNS_RECORD_SIZE: c.MAX_IPNS_RECORD_SIZE,
  MAX_IPNS_KEY_BYTES: c.MAX_IPNS_KEY_BYTES,

  DEFAULT_MAX_AUTH_FRAME_BYTES: c.DEFAULT_MAX_AUTH_FRAME_BYTES,
  DEFAULT_WRITE_TIMEOUT_MS: c.DEFAULT_WRITE_TIMEOUT_MS,
  DEFAULT_ACK_TIMEOUT_MS: c.DEFAULT_ACK_TIMEOUT_MS,
  DEFAULT_IDLE_TIMEOUT_MS: c.DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_HANDSHAKE_TIMEOUT_MS: c.DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_CALLBACK_TIMEOUT_MS: c.DEFAULT_CALLBACK_TIMEOUT_MS,
  DEFAULT_MIN_BYTES_PER_SECOND: c.DEFAULT_MIN_BYTES_PER_SECOND,
  DEFAULT_RATE_WINDOW_MS: c.DEFAULT_RATE_WINDOW_MS,
  DEFAULT_MAX_STREAM_MS: c.DEFAULT_MAX_STREAM_MS,
} as const;

// receive a push
export { createZzzyncHandler, registerZzzyncHandler } from "./handler.ts";
export type {
  Allow,
  AllowOptions,
  AuthOptions,
  CarLimits,
  CreateHandlerOptions,
  OnReceive,
  ReceivedRecord,
} from "./handler.ts";

// send one
export { dialZzzync, zzzync } from "./dialer.ts";
export type {
  DialOptions,
  DialProgressEvents,
  ZzzyncDialProgressEvents,
} from "./dialer.ts";

// prove ownership of an ipns key
export { createSign, generateNonce, verifyChallenge } from "./challenge.ts";
export type { Sign, SupportedPrivateKey } from "./challenge.ts";

// serve and fetch ipns records over the libp2p fetch protocol
export {
  createIpnsRecordLookup,
  fetchIpnsRecord,
  registerFetchIpnsLookup,
} from "./libp2p-fetch/ipns.ts";
export type { IpnsRecordLookupComponents } from "./libp2p-fetch/ipns.ts";

// ipns and CID helpers a consumer needs to talk about names and values
export {
  contenthash,
  parsedRecordValue,
  publicKeyAsIpnsMultihash,
} from "./utils.ts";

export * from "./interface.ts";
