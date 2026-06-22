import type { PublicKey } from "@libp2p/interface";
import type { IPNSRecord } from "ipns";
import type { CID, MultihashDigest } from "multiformats/cid";
import type {
  CID_VERSION_1,
  CODEC_DAG_CBOR,
  CODEC_DAG_PB,
  CODEC_IDENTITY,
  CODEC_LIBP2P_KEY,
  CODEC_RAW,
} from "./constants.ts";
import type { SupportedHasherCodes } from "./utils.ts";

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
  typeof CODEC_DAG_PB | typeof CODEC_RAW | typeof CODEC_DAG_CBOR,
  SupportedHasherCodes,
  1
>;

/**
 * The input a dialer pushes: a published IPNS record and the public key whose
 * IPNS name it was published under.
 */
export interface PushInput {
  record: IPNSRecord;
  publicKey: PublicKey;
}
