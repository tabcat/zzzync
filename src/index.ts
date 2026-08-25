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
 *     // 5MiB needs at least 1456 B/s to land inside the 1h backstop, so the
 *     // default 1KiB/s floor would cut it off; 2KiB/s finishes in ~43min
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
export * from "./constants.ts";
export { dialZzzync, zzzync } from "./dialer.ts";
export { createZzzyncHandler, registerZzzyncHandler } from "./handler.ts";
export type {
  Allow,
  CreateHandlerOptions,
  OnReceive,
  ReceivedRecord,
} from "./handler.ts";
export * from "./interface.ts";
