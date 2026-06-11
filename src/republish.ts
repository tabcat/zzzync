import type { AbortOptions } from "@libp2p/interface";
import type { PeerResponseEvent } from "@libp2p/kad-dht";
import type { IPNS, IPNSRecord } from "@tabcat/helia-ipns";
import type { IpnsMultihash } from "./interface.js";

export interface ProgressEventLike {
  type: string;
  detail?: unknown;
}

export interface PutValueCounter {
  onProgress: (evt: ProgressEventLike) => void;
  readonly peers: Set<string>;
}

export function countPutValuePeers(): PutValueCounter {
  const peers = new Set<string>();
  return {
    peers,
    onProgress(evt) {
      if (evt.type !== "kad-dht:query:peer-response") return;
      const detail = evt.detail as PeerResponseEvent;
      if (detail.messageName !== "PUT_VALUE") return;
      peers.add(detail.from.toString());
    },
  };
}

export interface RepublishWithRetryOptions extends AbortOptions {
  /** Distinct DHT peers that must ack a PUT_VALUE for success. Default 10. */
  minPeers?: number;
  /** Maximum republish attempts before giving up. Default 3. */
  maxAttempts?: number;
}

export interface RepublishResult {
  /** Whether the last attempt reached `minPeers`. */
  reached: boolean;
  /** Distinct PUT_VALUE peers seen on the last attempt. */
  peers: number;
  /** Number of republish attempts made. */
  attempts: number;
}

export async function republishWithRetry(
  ipns: Pick<IPNS, "republish">,
  name: IpnsMultihash,
  record: IPNSRecord,
  options: RepublishWithRetryOptions = {},
): Promise<RepublishResult> {
  const { minPeers = 10, maxAttempts = 3, signal } = options;

  let attempts = 0;
  let peers = 0;
  while (attempts < maxAttempts) {
    signal?.throwIfAborted();
    attempts++;
    const counter = countPutValuePeers();
    await ipns.republish(name, {
      record,
      skipResolution: true,
      onProgress: counter.onProgress,
      signal,
    });
    peers = counter.peers.size;
    if (peers >= minPeers) break;
  }

  return { reached: peers >= minPeers, peers, attempts };
}
