import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { secp256k1 as secp } from "@noble/curves/secp256k1.js";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildChallenge,
  createSign,
  generateNonce,
  verifyChallenge,
} from "../src/challenge.ts";
import type { SupportedPrivateKey } from "../src/challenge.ts";
import { publicKeyToIpnsMultihash } from "../src/utils.ts";

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
      const ipnsMh = publicKeyToIpnsMultihash(sk.publicKey)!;
      const n1 = generateNonce();
      const n2 = generateNonce();

      expect(buildChallenge(peerId, ipnsMh, n1, n2)).toEqual(
        buildChallenge(peerId, ipnsMh, n1, n2),
      );
    });

    it("differs when nonces differ", async () => {
      const peerId = peerIdFromPrivateKey(sk);
      const ipnsMh = publicKeyToIpnsMultihash(sk.publicKey)!;

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
      const ipnsMh = publicKeyToIpnsMultihash(sk.publicKey)!;
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

    it("produces a compact 64-byte secp256k1 signature that verifies", async () => {
      const secp = (await generateKeyPair("secp256k1")) as SupportedPrivateKey;
      const peerId = peerIdFromPrivateKey(secp);
      const ipnsMh = publicKeyToIpnsMultihash(secp.publicKey)!;
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
      // verifyChallenge converts compact -> DER before verifying
      expect(await verifyChallenge(secp.publicKey, challenge, sig)).toBe(true);
    });

    it("a signature from a different key does not verify", async () => {
      const other = (await generateKeyPair("Ed25519")) as SupportedPrivateKey;
      const peerId = peerIdFromPrivateKey(sk);
      const ipnsMh = publicKeyToIpnsMultihash(sk.publicKey)!;
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

  describe("verifyChallenge", () => {
    it("verifies an Ed25519 signature", async () => {
      const peerId = peerIdFromPrivateKey(sk);
      const ipnsMh = publicKeyToIpnsMultihash(sk.publicKey)!;
      const challenge = buildChallenge(
        peerId,
        ipnsMh,
        generateNonce(),
        generateNonce(),
      );
      const sig = await createSign(sk)(challenge);

      expect(await verifyChallenge(sk.publicKey, challenge, sig)).toBe(true);
    });

    it("rejects a signature from a different key", async () => {
      const other = (await generateKeyPair("Ed25519")) as SupportedPrivateKey;
      const peerId = peerIdFromPrivateKey(sk);
      const ipnsMh = publicKeyToIpnsMultihash(sk.publicKey)!;
      const challenge = buildChallenge(
        peerId,
        ipnsMh,
        generateNonce(),
        generateNonce(),
      );
      const sig = await createSign(other)(challenge);

      expect(await verifyChallenge(sk.publicKey, challenge, sig)).toBe(false);
    });

    it("rejects a high-S (malleated) secp256k1 signature", async () => {
      const secpKey =
        (await generateKeyPair("secp256k1")) as SupportedPrivateKey;
      const peerId = peerIdFromPrivateKey(secpKey);
      const ipnsMh = publicKeyToIpnsMultihash(secpKey.publicKey)!;
      const challenge = buildChallenge(
        peerId,
        ipnsMh,
        generateNonce(),
        generateNonce(),
      );

      // createSign emits a low-S compact sig (noble normalizes s on sign)
      const lowS = await createSign(secpKey)(challenge);
      expect(await verifyChallenge(secpKey.publicKey, challenge, lowS)).toBe(
        true,
      );

      // malleate to the high-S twin: same r, s -> n - s. Still a valid (r, s)
      // for the same message+key, just the non-canonical encoding.
      const sig = secp.Signature.fromBytes(lowS, "compact");
      const highS = new secp.Signature(sig.r, secp.Point.Fn.neg(sig.s));
      expect(highS.hasHighS()).toBe(true); // sanity: we built a high-S sig

      // verifyChallenge adds no explicit low-S guard; this asserts the malleable
      // twin is rejected anyway, because @noble (via @libp2p/crypto) verifies
      // low-S only by default. If that upstream default ever changes, this fails
      // loudly instead of silently accepting malleable challenge responses.
      expect(
        await verifyChallenge(
          secpKey.publicKey,
          challenge,
          highS.toBytes("compact"),
        ),
      )
        .toBe(false);
    });
  });
});
