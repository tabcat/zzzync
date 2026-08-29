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
import { ZZZYNC_PUSH_PROTOCOL_ID } from "../src/constants.ts";
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

    // Each of the four inputs is a separate defence, and the suite used to
    // pass with every one of them removed: both sides call buildChallenge, so
    // any self-consistent definition works end to end. These vary one input at
    // a time so a dropped binding fails here instead of shipping.
    it("prefixes the protocol id, so the signature is not reusable elsewhere", async () => {
      const peerId = peerIdFromPrivateKey(sk);
      const ipnsMh = publicKeyToIpnsMultihash(sk.publicKey)!;
      const challenge = buildChallenge(
        peerId,
        ipnsMh,
        generateNonce(),
        generateNonce(),
      );

      // this key also signs IPNS records; without the domain separator a
      // signature made elsewhere could be replayed as a challenge response
      const prefix = new TextEncoder().encode(ZZZYNC_PUSH_PROTOCOL_ID);
      expect(challenge.subarray(0, prefix.length)).toEqual(prefix);
    });

    it("binds the handler peer id, so a response cannot be relayed", async () => {
      const other = peerIdFromPrivateKey(
        (await generateKeyPair("Ed25519")) as SupportedPrivateKey,
      );
      const ipnsMh = publicKeyToIpnsMultihash(sk.publicKey)!;
      const n1 = generateNonce();
      const n2 = generateNonce();

      expect(buildChallenge(peerIdFromPrivateKey(sk), ipnsMh, n1, n2)).not
        .toEqual(buildChallenge(other, ipnsMh, n1, n2));
    });

    it("binds the dialer ipns name", async () => {
      const peerId = peerIdFromPrivateKey(sk);
      const otherKey =
        (await generateKeyPair("Ed25519")) as SupportedPrivateKey;
      const n1 = generateNonce();
      const n2 = generateNonce();

      expect(
        buildChallenge(peerId, publicKeyToIpnsMultihash(sk.publicKey)!, n1, n2),
      )
        .not
        .toEqual(
          buildChallenge(
            peerId,
            publicKeyToIpnsMultihash(otherKey.publicKey)!,
            n1,
            n2,
          ),
        );
    });

    it("binds the handler nonce, so a captured response cannot be replayed", async () => {
      const peerId = peerIdFromPrivateKey(sk);
      const ipnsMh = publicKeyToIpnsMultihash(sk.publicKey)!;
      const dialerNonce = generateNonce();

      expect(buildChallenge(peerId, ipnsMh, generateNonce(), dialerNonce)).not
        .toEqual(buildChallenge(peerId, ipnsMh, generateNonce(), dialerNonce));
    });

    it("binds the dialer nonce, so the handler cannot choose the whole preimage", async () => {
      const peerId = peerIdFromPrivateKey(sk);
      const ipnsMh = publicKeyToIpnsMultihash(sk.publicKey)!;
      const handlerNonce = generateNonce();

      expect(buildChallenge(peerId, ipnsMh, handlerNonce, generateNonce())).not
        .toEqual(buildChallenge(peerId, ipnsMh, handlerNonce, generateNonce()));
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
