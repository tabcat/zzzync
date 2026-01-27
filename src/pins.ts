import type { Pins } from "@helia/interface";
import type { AbortOptions } from "interface-store";
import drain from "it-drain";
import type { CID } from "multiformats/cid";
import type { Libp2pKey } from "./interface.js";

// these need concurrency control over Pins per CID
// check if Pins already does this
export async function pin(
	pins: Pins,
	pinner: Libp2pKey,
	root: CID,
	options: AbortOptions = {},
): Promise<void> {
	const now = Date.now();
	try {
		await drain(
			pins.add(root, { ...options, metadata: { [pinner.toString()]: now } }),
		);
	} catch (e) {
		if (e instanceof Error && e.name === "AlreadyPinnedError") {
			const { metadata } = await pins.get(root, options);
			metadata[pinner.toString()] = now;
			await pins.setMetadata(root, metadata, options);
		} else {
			throw e;
		}
	}
}

export async function unpin(
	pins: Pins,
	pinner: Libp2pKey,
	prevRoot: CID,
	options: AbortOptions = {},
): Promise<void> {
	const { metadata } = await pins.get(prevRoot, options);

	if (metadata[pinner.toString()]) {
		delete metadata[pinner.toString()];
	}

	if (Object.keys(metadata).length > 0) {
		await pins.setMetadata(prevRoot, metadata, options);
	} else {
		await drain(pins.rm(prevRoot, options));
	}
}
