import {
  AbortOptions,
  Ed25519PrivateKey,
  PeerId,
  Secp256k1PrivateKey,
} from "@libp2p/interface";
import { secp256k1 as secp } from "@noble/curves/secp256k1.js";
import { Uint8ArrayList } from "uint8arraylist";
import { concat } from "uint8arrays";
import { ZZZYNC_PUSH_PROTOCOL_ID } from "./constants.ts";
import { IpnsMultihash } from "./interface.ts";

export type SupportedPrivateKey = Ed25519PrivateKey | Secp256k1PrivateKey;

export type Sign = SupportedPrivateKey["sign"];

export const generateNonce = (): Uint8Array =>
  crypto.getRandomValues(new Uint8Array(32));

export const createSign =
  (sk: SupportedPrivateKey): Sign =>
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

export async function verifyChallenge(
  publicKey: SupportedPrivateKey["publicKey"],
  challenge: Uint8Array | Uint8ArrayList,
  sig: Uint8Array,
  options: AbortOptions = {},
): Promise<boolean> {
  if (publicKey.type === "secp256k1") {
    // createSign emits compact secp256k1 sigs for a uniform 64-byte wire width;
    // @libp2p/crypto verify expects DER, so convert back before verifying.
    const der = secp.Signature.fromBytes(sig, "compact").toBytes("der");
    return publicKey.verify(challenge, der, options);
  }

  return publicKey.verify(challenge, sig, options);
}

export function buildChallenge(
  handlerPeerId: PeerId,
  dialerIpns: IpnsMultihash,
  handlerNonce: Uint8Array,
  dialerNonce: Uint8Array,
): Uint8Array {
  return concat([
    new TextEncoder().encode(ZZZYNC_PUSH_PROTOCOL_ID),
    handlerPeerId.toMultihash().bytes,
    dialerIpns.bytes,
    handlerNonce,
    dialerNonce,
  ]);
}
