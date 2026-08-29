/**
 * @packageDocumentation
 *
 * A libp2p protocol for handing a signed dataset to another peer that can serve
 * it as a verifiable replica of the original publisher.
 *
 * A publisher proves it holds an IPNS key, sends a signed IPNS record, waits for
 * the handler to accept it, then streams a CAR of its content. The handler
 * verifies the signature and the content, then hands the record to your
 * application to pin and serve. The result is a durable, verifiable copy that
 * stays available even while the publisher is offline.
 *
 * The CAR format sets no maximum of any kind, so every size limit is yours to
 * choose and `CarLimits` requires all four. `maxByteLength` and `maxBlockCount`
 * are zzzync's own and accept `Infinity` for no cap. `maxCarSectionSize` and
 * `maxCarHeaderSize` go to `@ipld/car`, which rejects `Infinity`, so pass its
 * own defaults (8MiB and 32MiB) to leave those alone.
 *
 * @example Receive pushes (handler)
 *
 * ```ts
 * import { car } from '@helia/car'
 * import {
 *   createZzzyncHandler,
 *   publicKeyFromIpnsMultihash,
 *   registerZzzyncHandler,
 * } from '@tabcat/zzzync'
 *
 * const handler = createZzzyncHandler(
 *   helia.libp2p.peerId,
 *   car(helia),
 *   {
 *     // gate which keys may push, and which records to accept
 *     multihash: (name) => {
 *       const key = publicKeyFromIpnsMultihash(name)
 *       return key != null && myAllowList.has(key.toCID().toString())
 *     },
 *     record: (name, record) => true,
 *   },
 *   {
 *     maxByteLength: 5 * 1024 * 1024,
 *     maxBlockCount: 10_000,
 *     maxCarSectionSize: 2 * 1024 * 1024,
 *     maxCarHeaderSize: 1024,
 *   },
 *   async ({ name, record, pinner }) => {
 *     // record is signature-verified and its CAR fully validated;
 *     // pin the content, persist the record, then serve and announce it
 *   },
 *   {
 *     // the cap in force is min(maxByteLength, minBytesPerSecond * maxStreamMs),
 *     // so the default 1KiB/s floor would hold the 5MiB above to 3.52MiB;
 *     // 2KiB/s makes it actually reachable, in ~43min
 *     minBytesPerSecond: 2048,
 *     // byteStream buffers ahead of the importer, so keep this above
 *     // maxByteLength or a fast sender trips the buffer before the size limit
 *     maxBufferSize: 6 * 1024 * 1024,
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
 * import { createSign, dialZzzync } from '@tabcat/zzzync'
 * import { createIPNSRecord } from 'ipns'
 *
 * // sign a record for the content, then push both to a handler peer. Publishing
 * // through @helia/ipns instead gives you a protobuf IPNSEntry, so unmarshal it
 * // before passing it here.
 * const record = await createIPNSRecord(privateKey, cid, 0, 3_600_000)
 *
 * await dialZzzync(
 *   helia.libp2p,
 *   handlerPeerId,
 *   car(helia),
 *   { record, publicKey: privateKey.publicKey },
 *   createSign(privateKey),
 * )
 * ```
 */
/**
 * The two identifiers zzzync owns. Everything else it uses internally is a
 * standard multicodec, CID or IPNS value belonging to multiformats or the IPNS
 * spec, so take those from their source rather than couple to zzzync's copy.
 */
export { ZZZYNC, ZZZYNC_PUSH_PROTOCOL_ID } from "./constants.ts";

// receive a push
export { createZzzyncHandler, registerZzzyncHandler } from "./handler.ts";
export type {
  Allow,
  AllowOptions,
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
export { createSign } from "./challenge.ts";
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
  publicKeyFromIpnsMultihash,
  publicKeyToIpnsMultihash,
} from "./utils.ts";

// publicKeyFromIpnsMultihash returns one, so a consumer cannot name its result
// without this
export type { SupportedHasherCodes, SupportedPublicKey } from "./utils.ts";

export type {
  IpnsMultihash,
  // ReceivedRecord.pinner is one, so naming that field needs it
  Libp2pKey,
  PushInput,
  UnixFsCID,
} from "./interface.ts";
