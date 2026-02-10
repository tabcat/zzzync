import type { Pin, Pins } from "@helia/interface";
import type { AbortOptions } from "interface-store";
import drain from "it-drain";
import type { CID } from "multiformats/cid";
import type { Libp2pKey } from "./interface.js";

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
  } catch (e) {
    if (e instanceof Error && e.name === "AlreadyPinnedError") {
      const { metadata } = await pins.get(cid, options);

      if (metadata[pinner.toString()]) {
        return;
      } else {
        metadata[pinner.toString()] = now;
      }

      await pins.setMetadata(cid, metadata, options);
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
  } else {
    return;
  }

  if (Object.keys(metadata).length > 0) {
    await pins.setMetadata(cid, metadata, options);
  } else {
    await drain(pins.rm(cid, options));
  }
}
