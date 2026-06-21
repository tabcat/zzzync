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
 * The wire protocol is specified in
 * {@link https://github.com/tabcat/zzzync/blob/master/spec.md | spec.md}.
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
 *   async ({ name, record, pinner }) => {
 *     // record is signature-verified and its CAR fully validated;
 *     // pin the content, persist the record, then serve and announce it
 *   }
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
 * const published = await name.publish(keyName, cid)
 *
 * await dialZzzync(
 *   helia.libp2p,
 *   handlerPeerId,
 *   car(helia),
 *   published,
 *   createSign(privateKey)
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
