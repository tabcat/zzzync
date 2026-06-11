import type { Pins } from "@helia/interface";
import type { IPNS } from "@tabcat/helia-ipns";
import type { CID, MultihashDigest } from "multiformats/cid";
import type {
  CID_VERSION_1,
  CODEC_DAG_PB,
  CODEC_IDENTITY,
  CODEC_LIBP2P_KEY,
  CODEC_RAW,
} from "./constants.js";
import type { SupportedHasherCodes } from "./utils.js";

/**
 * CID<0x1, 0x72, 0x00>
 */
export type Libp2pKey = CID<
  Uint8Array,
  typeof CODEC_LIBP2P_KEY,
  typeof CODEC_IDENTITY,
  typeof CID_VERSION_1
>;

/**
 * MultihashDigest<0x00>
 */
export type IpnsMultihash = MultihashDigest<typeof CODEC_IDENTITY>;

export type UnixFsCID = CID<
  unknown,
  typeof CODEC_DAG_PB | typeof CODEC_RAW,
  SupportedHasherCodes,
  1
>;

/**
 * The subset of Helia's `IPNS` interface the zzzync handler depends on. Provide
 * your own implementation of these methods to back the handler with a custom
 * IPNS router.
 */
export type HandlerIpns = Pick<IPNS, "resolve" | "republish">;

/**
 * The subset of Helia's `Pins` interface the zzzync handler depends on. Provide
 * your own implementation of these methods to back the handler with a custom
 * pin store.
 */
export type HandlerPins = Pick<
  Pins,
  "add" | "get" | "setMetadata" | "rm" | "isPinned"
>;
