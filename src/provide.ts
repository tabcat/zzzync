import type { AbortOptions } from "@libp2p/interface";
import type { CID } from "multiformats/cid";
import { countQueryPeers } from "./republish.js";
import type { ProgressEventLike, PutValueCounter } from "./republish.js";

export type { ProgressEventLike, PutValueCounter };

export function countAddProviderPeers(): PutValueCounter {
  return countQueryPeers("ADD_PROVIDER");
}

export interface ProvideWithRetryOptions extends AbortOptions {
  /** Distinct DHT peers that must store the provider record for success. Default 10. */
  minProviders?: number;
  /** Maximum provide attempts before giving up. Default 3. */
  maxAttempts?: number;
}

export interface ProvideResult {
  /** Whether the last attempt reached `minProviders`. */
  reached: boolean;
  /** Distinct ADD_PROVIDER peers seen on the last attempt. */
  peers: number;
  /** Number of provide attempts made. */
  attempts: number;
}

export interface ProvideRouting {
  provide(
    cid: CID,
    options?: {
      onProgress?: (evt: ProgressEventLike) => void;
      signal?: AbortSignal;
    },
  ): Promise<void>;
}

export async function provideWithRetry(
  routing: ProvideRouting,
  value: CID,
  options: ProvideWithRetryOptions = {},
): Promise<ProvideResult> {
  const { minProviders = 10, maxAttempts = 3, signal } = options;

  let attempts = 0;
  let peers = 0;
  while (attempts < maxAttempts) {
    signal?.throwIfAborted();
    attempts++;
    const counter = countAddProviderPeers();
    await routing.provide(value, { onProgress: counter.onProgress, signal });
    peers = counter.peers.size;
    if (peers >= minProviders) break;
  }

  return { reached: peers >= minProviders, peers, attempts };
}
