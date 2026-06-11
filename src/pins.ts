import type { Pin } from "@helia/interface";
import { logger } from "@libp2p/logger";
import type { AbortOptions } from "interface-store";
import drain from "it-drain";
import type { CID } from "multiformats/cid";
import { ZZZYNC } from "./constants.js";
import type { HandlerPins, Libp2pKey } from "./interface.js";
import { createKeyedMutex } from "./mutex.js";

export const PINS_NAMESPACE = `${ZZZYNC}:pins`;
const log = logger(PINS_NAMESPACE);

// pin/unpin update a cid's pinner metadata with a read-modify-write that is not
// atomic in the Pins store. Concurrent calls for the same cid would drop each
// other's pinners (and helia deadlocks under the contention), so serialize the
// critical section per cid. Different cids never block each other.
const mutex = createKeyedMutex();

export async function pin(
  pins: HandlerPins,
  pinner: Libp2pKey,
  cid: CID,
  options: AbortOptions = {},
): Promise<void> {
  return mutex.acquire(cid.toString(), async () => {
    const now = Date.now();
    try {
      await drain(
        pins.add(cid, { ...options, metadata: { [pinner.toString()]: now } }),
      );
      log("pinned %c", cid, pinner);
    } catch (e) {
      if (e instanceof Error && e.name === "AlreadyPinnedError") {
        const { metadata } = await pins.get(cid, options);

        if (metadata[pinner.toString()]) {
          log("%c is already pinned for pinner %c", cid, pinner);
          return;
        } else {
          metadata[pinner.toString()] = now;
        }

        await pins.setMetadata(cid, metadata, options);
        log("pinned %c for pinner %c", cid, pinner);
      } else {
        throw e;
      }
    }
  });
}

export async function unpin(
  pins: HandlerPins,
  pinner: Libp2pKey,
  cid: CID,
  options: AbortOptions = {},
): Promise<void> {
  return mutex.acquire(cid.toString(), async () => {
    let metadata: Pin["metadata"];
    try {
      const pin = await pins.get(cid, options);
      metadata = pin.metadata;
    } catch (e) {
      if (e instanceof Error && e.name === "NotFoundError") {
        metadata = {};
      } else {
        throw e;
      }
    }

    if (metadata[pinner.toString()]) {
      delete metadata[pinner.toString()];
    } else {
      log("%c is not pinned for pinner %c", cid, pinner);
      return;
    }

    if (Object.keys(metadata).length > 0) {
      await pins.setMetadata(cid, metadata, options);
      log("unpinned %c for pinner %c", cid, pinner);
    } else {
      await drain(pins.rm(cid, options));
      log("unpinned %c", cid);
    }
  });
}
