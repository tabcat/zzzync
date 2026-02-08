import { randomBytes } from "@libp2p/crypto";
import {
  AbortOptions,
  Ed25519PrivateKey,
  Ed25519PublicKey,
  PeerId,
  PrivateKey,
  PublicKey,
  Secp256k1PrivateKey,
  Secp256k1PublicKey,
} from "@libp2p/interface";
import { secp256k1 as secp } from "@noble/curves/secp256k1.js";
import { Uint8ArrayList } from "uint8arraylist";
import { concat } from "uint8arrays";
import { ZZZYNC_PROTOCOL_ID } from "./constants.js";
import { IpnsMultihash } from "./interface.js";

export type SupportedPrivateKeys = Ed25519PrivateKey | Secp256k1PrivateKey;

export type SupportedPublicKeys = Ed25519PublicKey | Secp256k1PublicKey;

export type Sign = PrivateKey["sign"];

export type Verify = PublicKey["verify"];

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

export const createVerify =
  (pk: SupportedPublicKeys): Verify =>
  async (
    data: Uint8Array | Uint8ArrayList,
    sig: Uint8Array,
    options: AbortOptions = {},
  ): Promise<boolean> => {
    if (pk.type === "secp256k1") {
      const sigDER = secp.Signature.fromBytes(sig, "compact").toBytes("der");

      return pk.verify(data, sigDER, options);
    } else {
      return pk.verify(data, sig, options);
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

export async function verifyResponse(
  handlerPeerId: PeerId,
  dialerIpns: IpnsMultihash,
  handlerNonce: Uint8Array,
  dialerNonce: Uint8Array,
  sig: Uint8Array,
  verify: Verify,
  options: AbortOptions = {},
): Promise<boolean> {
  const challenge = buildChallenge(
    handlerPeerId,
    dialerIpns,
    handlerNonce,
    dialerNonce,
  );

  return verify(challenge, sig, options);
}

export async function signChallenge(
  handlerPeerId: PeerId,
  dialerIpns: IpnsMultihash,
  handlerNonce: Uint8Array,
  sign: Sign,
  options: AbortOptions = {},
): Promise<[Uint8Array, Uint8Array]> {
  const dialerNonce = randomBytes(32);
  const challenge = buildChallenge(
    handlerPeerId,
    dialerIpns,
    handlerNonce,
    dialerNonce,
  );

  return [await sign(challenge, options), dialerNonce];
}
