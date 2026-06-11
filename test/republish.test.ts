import { generateKeyPair } from "@libp2p/crypto/keys";
import type { PeerId } from "@libp2p/interface";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import type { IPNS, IPNSRecord } from "@tabcat/helia-ipns";
import { beforeAll, describe, expect, it } from "vitest";
import type { IpnsMultihash } from "../src/interface.js";
import {
  countPutValuePeers,
  type ProgressEventLike,
  republishWithRetry,
} from "../src/republish.js";
import { publicKeyAsIpnsMultihash } from "../src/utils.js";

async function randomPeerId(): Promise<PeerId> {
  return peerIdFromPrivateKey(await generateKeyPair("Ed25519"));
}

function peerResponse(from: PeerId, messageName: string) {
  return { type: "kad-dht:query:peer-response", detail: { from, messageName } };
}

describe("countPutValuePeers", () => {
  it("counts distinct peers that ack PUT_VALUE", async () => {
    const a = await randomPeerId();
    const b = await randomPeerId();
    const counter = countPutValuePeers();

    counter.onProgress(peerResponse(a, "PUT_VALUE"));
    counter.onProgress(peerResponse(b, "PUT_VALUE"));

    expect(counter.peers.size).toBe(2);
    expect(counter.peers.has(a.toString())).toBe(true);
    expect(counter.peers.has(b.toString())).toBe(true);
  });

  it("ignores peer-responses that are not PUT_VALUE", async () => {
    const a = await randomPeerId();
    const counter = countPutValuePeers();

    counter.onProgress(peerResponse(a, "FIND_NODE"));

    expect(counter.peers.size).toBe(0);
  });

  it("ignores unrelated progress events", () => {
    const counter = countPutValuePeers();

    counter.onProgress({ type: "ipns:republish:start" });
    counter.onProgress({ type: "kad-dht:query:dial-peer", detail: {} });

    expect(counter.peers.size).toBe(0);
  });

  it("deduplicates the same peer", async () => {
    const a = await randomPeerId();
    const counter = countPutValuePeers();

    counter.onProgress(peerResponse(a, "PUT_VALUE"));
    counter.onProgress(peerResponse(a, "PUT_VALUE"));

    expect(counter.peers.size).toBe(1);
  });
});

// Fake ipns whose republish emits `peerCountsPerAttempt[n]` distinct PUT_VALUE
// peer-responses on the nth attempt (reusing the last entry once exhausted).
function fakeIpns(peerCountsPerAttempt: number[]) {
  let attempts = 0;
  const ipns = {
    async republish(
      _name: unknown,
      options?: { onProgress?: (evt: ProgressEventLike) => void; },
    ): Promise<{ record: IPNSRecord; }> {
      const n = peerCountsPerAttempt[attempts]
        ?? peerCountsPerAttempt[peerCountsPerAttempt.length - 1]
        ?? 0;
      attempts++;
      for (let i = 0; i < n; i++) {
        options?.onProgress?.({
          type: "kad-dht:query:peer-response",
          detail: {
            from: { toString: () => `peer-${i}` },
            messageName: "PUT_VALUE",
          },
        });
      }
      return { record: {} as IPNSRecord };
    },
  };
  return {
    ipns: ipns as unknown as Pick<IPNS, "republish">,
    getAttempts: () => attempts,
  };
}

describe("republishWithRetry", () => {
  let name: IpnsMultihash;
  const record = {} as IPNSRecord;

  beforeAll(async () => {
    const key = await generateKeyPair("Ed25519");
    const ipns = publicKeyAsIpnsMultihash(key.publicKey);
    if (ipns == null) throw new Error("expected ipns multihash");
    name = ipns;
  });

  it("reports reached when the publish hits minPeers", async () => {
    const { ipns } = fakeIpns([10]);

    const result = await republishWithRetry(ipns, name, record);

    expect(result.reached).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.peers).toBe(10);
  });

  it("retries until it reaches minPeers", async () => {
    const { ipns } = fakeIpns([3, 10]);

    const result = await republishWithRetry(ipns, name, record, {
      minPeers: 10,
    });

    expect(result.attempts).toBe(2);
    expect(result.reached).toBe(true);
    expect(result.peers).toBe(10);
  });

  it("gives up after maxAttempts when minPeers is never reached", async () => {
    const { ipns } = fakeIpns([2]);

    const result = await republishWithRetry(ipns, name, record);

    expect(result.reached).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.peers).toBe(2);
  });

  it("does not attempt once the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { ipns, getAttempts } = fakeIpns([2]);

    await expect(
      republishWithRetry(ipns, name, record, { signal: controller.signal }),
    )
      .rejects
      .toThrow();
    expect(getAttempts()).toBe(0);
  });
});
