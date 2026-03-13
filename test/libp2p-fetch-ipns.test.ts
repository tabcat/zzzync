import { generateKeyPair } from "@libp2p/crypto/keys";
import { Record } from "@libp2p/kad-dht";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import type { Datastore } from "interface-datastore";
import { Key } from "interface-datastore";
import {
  createIPNSRecord,
  marshalIPNSRecord,
  multihashToIPNSRoutingKey,
} from "ipns";
import sinon from "sinon";
import { stubInterface } from "sinon-ts";
import { toString as uint8ArrayToString } from "uint8arrays";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createIpnsRecordLookup,
  fetchIpnsRecord,
} from "../src/libp2p-fetch/ipns.js";
import { publicKeyAsIpnsMultihash } from "../src/utils.js";

// ─── shared fixtures ──────────────────────────────────────────────────────────

let key: Awaited<ReturnType<typeof generateKeyPair>>;
let marshalled: Uint8Array;
let ipnsMultihash: NonNullable<ReturnType<typeof publicKeyAsIpnsMultihash>>;
let routingKey: Uint8Array;

beforeAll(async () => {
  key = await generateKeyPair("Ed25519");
  ipnsMultihash = publicKeyAsIpnsMultihash(key.publicKey)!;
  routingKey = multihashToIPNSRoutingKey(ipnsMultihash);

  const record = await createIPNSRecord(
    key as any,
    // a well-known empty-directory CID
    (await import("multiformats/cid")).CID.parse(
      "QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn",
    ),
    0,
    3_600_000,
  );
  marshalled = marshalIPNSRecord(record);
});

afterEach(() => sinon.restore());

// ─── fetchIpnsRecord ──────────────────────────────────────────────────────────

describe("fetchIpnsRecord", () => {
  it("returns undefined when fetch returns nothing", async () => {
    const fetchFn = sinon.stub().resolves(undefined);
    const peerId = peerIdFromPrivateKey(key);

    const result = await fetchIpnsRecord(fetchFn, peerId, ipnsMultihash);

    expect(result).toBeUndefined();
    expect(fetchFn.calledOnce).toBe(true);
  });

  it("returns a validated IPNSRecord when fetch returns marshalled bytes", async () => {
    const fetchFn = sinon.stub().resolves(marshalled);
    const peerId = peerIdFromPrivateKey(key);

    const result = await fetchIpnsRecord(fetchFn, peerId, ipnsMultihash);

    expect(result).toBeDefined();
    expect(result!.sequence).toBe(0n);
  });
});

// ─── createIpnsRecordLookup ───────────────────────────────────────────────────

function dstoreKey(key: Uint8Array): Key {
  return new Key("/dht/record/" + uint8ArrayToString(key, "base32"), false);
}

describe("createIpnsRecordLookup", () => {
  it("returns undefined when the key is not found", async () => {
    const datastore = stubInterface<Datastore>();
    datastore.get.rejects(
      Object.assign(new Error("Not Found"), { name: "NotFoundError" }),
    );

    const lookup = createIpnsRecordLookup({ datastore });
    expect(await lookup(routingKey)).toBeUndefined();
    expect(datastore.get.calledWith(dstoreKey(routingKey))).toBe(true);
  });

  it("propagates errors other than NotFoundError", async () => {
    const datastore = stubInterface<Datastore>();
    datastore.get.rejects(new Error("storage failure"));

    const lookup = createIpnsRecordLookup({ datastore });
    await expect(lookup(routingKey)).rejects.toThrow("storage failure");
  });

  it("returns the record value when found", async () => {
    const value = new Uint8Array([1, 2, 3, 4]);
    const serialized = new Record(routingKey, value, new Date()).serialize();

    const datastore = stubInterface<Datastore>();
    datastore.get.resolves(serialized);

    const lookup = createIpnsRecordLookup({ datastore });
    const result = await lookup(routingKey);
    expect(result).toEqual(value);
  });
});
