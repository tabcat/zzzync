import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { beforeEach, describe, expect, it } from "vitest";
import { buildChallenge, createSign, generateNonce } from "../src/challenge.ts";
import type { SupportedPrivateKey } from "../src/challenge.ts";
import { publicKeyAsIpnsMultihash } from "../src/utils.ts";

describe("challenge", () => {
  let sk: SupportedPrivateKey;

  beforeEach(async () => {
    sk = (await generateKeyPair("Ed25519")) as SupportedPrivateKey;
  });

  describe("generateNonce", () => {
    it("returns 32 bytes", () => {
      expect(generateNonce().length).toBe(32);
    });

    it("produces unique values on each call", () => {
      const a = generateNonce();
      const b = generateNonce();
      expect(a).not.toEqual(b);
    });
  });

  describe("buildChallenge", () => {
    it("is deterministic for identical inputs", async () => {
      const peerId = peerIdFromPrivateKey(sk);
      const ipnsMh = publicKeyAsIpnsMultihash(sk.publicKey)!;
      const n1 = generateNonce();
      const n2 = generateNonce();

      expect(buildChallenge(peerId, ipnsMh, n1, n2)).toEqual(
        buildChallenge(peerId, ipnsMh, n1, n2),
      );
    });

    it("differs when nonces differ", async () => {
      const peerId = peerIdFromPrivateKey(sk);
      const ipnsMh = publicKeyAsIpnsMultihash(sk.publicKey)!;

      const a = buildChallenge(
        peerId,
        ipnsMh,
        generateNonce(),
        generateNonce(),
      );
      const b = buildChallenge(
        peerId,
        ipnsMh,
        generateNonce(),
        generateNonce(),
      );

      expect(a).not.toEqual(b);
    });
  });

  describe("createSign", () => {
    it("produces a 64-byte signature for Ed25519 that verifies", async () => {
      const peerId = peerIdFromPrivateKey(sk);
      const ipnsMh = publicKeyAsIpnsMultihash(sk.publicKey)!;
      const challenge = buildChallenge(
        peerId,
        ipnsMh,
        generateNonce(),
        generateNonce(),
      );
      const sign = createSign(sk);
      const sig = await sign(challenge);

      expect(sig.length).toBe(64);
      expect(await sk.publicKey.verify(challenge, sig)).toBe(true);
    });

    it("produces a compact 64-byte signature for secp256k1", async () => {
      const secp = (await generateKeyPair("secp256k1")) as SupportedPrivateKey;
      const peerId = peerIdFromPrivateKey(secp);
      const ipnsMh = publicKeyAsIpnsMultihash(secp.publicKey)!;
      const challenge = buildChallenge(
        peerId,
        ipnsMh,
        generateNonce(),
        generateNonce(),
      );
      const sign = createSign(secp);
      const sig = await sign(challenge);

      // DER-encoded secp256k1 sigs are variable-length; compact is always 64
      expect(sig.length).toBe(64);
    });

    it("a signature from a different key does not verify", async () => {
      const other = (await generateKeyPair("Ed25519")) as SupportedPrivateKey;
      const peerId = peerIdFromPrivateKey(sk);
      const ipnsMh = publicKeyAsIpnsMultihash(sk.publicKey)!;
      const challenge = buildChallenge(
        peerId,
        ipnsMh,
        generateNonce(),
        generateNonce(),
      );

      const sig = await createSign(other)(challenge);

      expect(await sk.publicKey.verify(challenge, sig)).toBe(false);
    });
  });
});
