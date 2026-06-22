import * as dagCbor from "@ipld/dag-cbor";
import * as dagPb from "@ipld/dag-pb";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { beforeAll, describe, expect, it } from "vitest";
import { CODEC_DAG_PB, IPFS_PREFIX } from "../src/constants.ts";
import {
  contenthash,
  getCodec,
  getHasher,
  parsedRecordValue,
  publicKeyAsIpnsMultihash,
} from "../src/utils.ts";

let dagPbCidStr: string;
let rawCidStr: string;
let ed25519Key: Awaited<ReturnType<typeof generateKeyPair>>;
let secp256k1Key: Awaited<ReturnType<typeof generateKeyPair>>;

beforeAll(async () => {
  const digest = await sha256.digest(new Uint8Array(10));
  dagPbCidStr = IPFS_PREFIX + CID.create(1, CODEC_DAG_PB, digest).toString();
  rawCidStr = IPFS_PREFIX + CID.create(1, 0x55, digest).toString();
  ed25519Key = await generateKeyPair("Ed25519");
  secp256k1Key = await generateKeyPair("secp256k1");
});

describe("parsedRecordValue", () => {
  it("returns a CID for a valid dag-pb value", () => {
    const cid = parsedRecordValue(dagPbCidStr);
    expect(cid).not.toBeNull();
    expect(cid!.code).toBe(CODEC_DAG_PB);
  });

  it("returns a CID for a valid raw value", () => {
    const cid = parsedRecordValue(rawCidStr);
    expect(cid).not.toBeNull();
    expect(cid!.code).toBe(0x55);
  });

  it("returns null for an invalid string", () => {
    expect(parsedRecordValue("not-a-cid")).toBeNull();
  });

  it("returns a CID for a valid dag-cbor value", async () => {
    const digest = await sha256.digest(new Uint8Array(10));
    const cborCid = CID.create(1, 0x71, digest);
    const cid = parsedRecordValue(IPFS_PREFIX + cborCid.toString());
    expect(cid).not.toBeNull();
    expect(cid!.code).toBe(0x71);
  });

  it("returns null for a value without the /ipfs/ prefix", () => {
    const cidStr = dagPbCidStr.slice(IPFS_PREFIX.length);
    expect(parsedRecordValue("/ipns/" + cidStr)).toBeNull();
  });
});

describe("getCodec", () => {
  it("returns the dag-pb codec for code 0x70", () => {
    expect(getCodec(CODEC_DAG_PB)).toBe(dagPb);
  });

  it("returns the dag-cbor codec for code 0x71", () => {
    expect(getCodec(0x71)).toBe(dagCbor);
  });

  it("returns the raw codec for code 0x55", () => {
    expect(getCodec(0x55)).toBe(raw);
  });

  it("throws for an unsupported codec", () => {
    expect(() => getCodec(0x99)).toThrow("Unsupported codec.");
  });
});

describe("getHasher", () => {
  it("returns sha256 for code 0x12", () => {
    expect(getHasher(sha256.code)).toBe(sha256);
  });

  it("throws for an unsupported hash code", () => {
    expect(() => getHasher(999)).toThrow("Unsupported hash code.");
  });
});

describe("publicKeyAsIpnsMultihash", () => {
  it("returns a multihash for an Ed25519 key", () => {
    expect(publicKeyAsIpnsMultihash(ed25519Key.publicKey)).not.toBeNull();
  });

  it("returns a multihash for a secp256k1 key", () => {
    expect(publicKeyAsIpnsMultihash(secp256k1Key.publicKey)).not.toBeNull();
  });
});

describe("contenthash", () => {
  it("returns an /ipns/ prefixed string", () => {
    const hash = contenthash(ed25519Key.publicKey);
    expect(hash.startsWith("/ipns/")).toBe(true);
  });

  it("is deterministic for the same key", () => {
    expect(contenthash(ed25519Key.publicKey)).toBe(
      contenthash(ed25519Key.publicKey),
    );
  });

  it("differs between keys", () => {
    expect(contenthash(ed25519Key.publicKey)).not.toBe(
      contenthash(secp256k1Key.publicKey),
    );
  });
});
