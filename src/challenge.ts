import { randomBytes } from "@libp2p/crypto";
import {
  AbortOptions,
  Ed25519PrivateKey,
  PeerId,
  PrivateKey,
  Secp256k1PrivateKey,
} from "@libp2p/interface";
import { secp256k1 as secp } from "@noble/curves/secp256k1.js";
import { Uint8ArrayList } from "uint8arraylist";
import { concat } from "uint8arrays";
import { ZZZYNC_PROTOCOL_ID } from "./constants.js";
import { IpnsMultihash } from "./interface.js";

export type SupportedPrivateKeys = Ed25519PrivateKey | Secp256k1PrivateKey;

export type Sign = PrivateKey["sign"];

export const generateNonce = () => randomBytes(32);

export const createSign =
  (sk: SupportedPrivateKeys): Sign =>
  async (
    data: Uint8Array | Uint8ArrayList,
    options: AbortOptions = {},
  ): Promise<Uint8Array> => {
    if (sk.type === "secp256k1") {
      const sigDER = await sk.sign(data, options);

      return secp.Signature.fromBytes(sigDER, "der").toBytes("compact");
    } else {
      return sk.sign(data, options);
    }
  };

export function buildChallenge(
  handlerPeerId: PeerId,
  dialerIpns: IpnsMultihash,
  handlerNonce: Uint8Array,
  dialerNonce: Uint8Array,
): Uint8Array {
  return concat([
    new TextEncoder().encode(ZZZYNC_PROTOCOL_ID),
    handlerPeerId.toMultihash().bytes,
    dialerIpns.bytes,
    handlerNonce,
    dialerNonce,
  ]);
}
