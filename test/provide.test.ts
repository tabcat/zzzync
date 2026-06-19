import { generateKeyPair } from "@libp2p/crypto/keys";
import type { PeerId } from "@libp2p/interface";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import type { CID } from "multiformats/cid";
import { describe, expect, it } from "vitest";
import {
  countAddProviderPeers,
  type ProgressEventLike,
  provideWithRetry,
} from "../src/provide.js";

async function randomPeerId(): Promise<PeerId> {
  return peerIdFromPrivateKey(await generateKeyPair("Ed25519"));
}

function peerResponse(from: PeerId, messageName: string) {
  return { type: "kad-dht:query:peer-response", detail: { from, messageName } };
}

describe("countAddProviderPeers", () => {
  it("counts distinct peers that ack ADD_PROVIDER", async () => {
    const a = await randomPeerId();
    const b = await randomPeerId();
    const counter = countAddProviderPeers();

    counter.onProgress(peerResponse(a, "ADD_PROVIDER"));
    counter.onProgress(peerResponse(b, "ADD_PROVIDER"));

    expect(counter.peers.size).toBe(2);
    expect(counter.peers.has(a.toString())).toBe(true);
    expect(counter.peers.has(b.toString())).toBe(true);
  });

  it("ignores peer-responses that are not ADD_PROVIDER", async () => {
    const a = await randomPeerId();
    const counter = countAddProviderPeers();

    counter.onProgress(peerResponse(a, "PUT_VALUE"));

    expect(counter.peers.size).toBe(0);
  });

  it("ignores unrelated progress events", () => {
    const counter = countAddProviderPeers();

    counter.onProgress({ type: "ipns:republish:start" });
    counter.onProgress({ type: "kad-dht:query:dial-peer", detail: {} });

    expect(counter.peers.size).toBe(0);
  });

  it("deduplicates the same peer", async () => {
    const a = await randomPeerId();
    const counter = countAddProviderPeers();

    counter.onProgress(peerResponse(a, "ADD_PROVIDER"));
    counter.onProgress(peerResponse(a, "ADD_PROVIDER"));

    expect(counter.peers.size).toBe(1);
  });
});

// Fake routing whose provide emits `peerCountsPerAttempt[n]` distinct
// ADD_PROVIDER peer-responses on the nth attempt (reusing the last entry once
// exhausted).
function fakeRouting(peerCountsPerAttempt: number[]) {
  let attempts = 0;
  const routing = {
    async provide(
      _cid: unknown,
      options?: { onProgress?: (evt: ProgressEventLike) => void; },
    ): Promise<void> {
      const n = peerCountsPerAttempt[attempts]
        ?? peerCountsPerAttempt[peerCountsPerAttempt.length - 1]
        ?? 0;
      attempts++;
      for (let i = 0; i < n; i++) {
        options?.onProgress?.({
          type: "kad-dht:query:peer-response",
          detail: {
            from: { toString: () => `peer-${i}` },
            messageName: "ADD_PROVIDER",
          },
        });
      }
    },
  };
  return {
    routing: routing as unknown as {
      provide: (
        cid: CID,
        options?: {
          onProgress?: (evt: ProgressEventLike) => void;
          signal?: AbortSignal;
        },
      ) => Promise<void>;
    },
    getAttempts: () => attempts,
  };
}

const fakeCid = {} as CID;

describe("provideWithRetry", () => {
  it("reports reached when provide hits minProviders", async () => {
    const { routing } = fakeRouting([10]);

    const result = await provideWithRetry(routing, fakeCid);

    expect(result.reached).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.peers).toBe(10);
  });

  it("retries until it reaches minProviders", async () => {
    const { routing } = fakeRouting([3, 10]);

    const result = await provideWithRetry(routing, fakeCid, {
      minProviders: 10,
    });

    expect(result.attempts).toBe(2);
    expect(result.reached).toBe(true);
    expect(result.peers).toBe(10);
  });

  it("gives up after maxAttempts when minProviders is never reached", async () => {
    const { routing } = fakeRouting([2]);

    const result = await provideWithRetry(routing, fakeCid);

    expect(result.reached).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.peers).toBe(2);
  });

  it("does not attempt once the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const { routing, getAttempts } = fakeRouting([2]);

    await expect(
      provideWithRetry(routing, fakeCid, { signal: controller.signal }),
    )
      .rejects
      .toThrow();
    expect(getAttempts()).toBe(0);
  });
});
