import type { Pin, Pins } from "@helia/interface";
import { logger } from "@libp2p/logger";
import type { AbortOptions } from "interface-store";
import drain from "it-drain";
import type { CID } from "multiformats/cid";
import { ZZZYNC } from "./constants.js";
import type { Libp2pKey } from "./interface.js";

export const PINS_NAMESPACE = `${ZZZYNC}:pins`;
const log = logger(PINS_NAMESPACE);

// these need concurrency control over Pins per CID
// check if Pins already does this
export async function pin(
  pins: Pins,
  pinner: Libp2pKey,
  cid: CID,
  options: AbortOptions = {},
): Promise<void> {
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
}

export async function unpin(
  pins: Pins,
  pinner: Libp2pKey,
  cid: CID,
  options: AbortOptions = {},
): Promise<void> {
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
    log("unpinned %c for pinner %c", cid, pinner);
  } else {
    log("%c is not pinned for pinner %c", cid, pinner);
    return;
  }

  if (Object.keys(metadata).length > 0) {
    await pins.setMetadata(cid, metadata, options);
  } else {
    await drain(pins.rm(cid, options));
    log("unpinned %c", cid, pinner);
  }
}
