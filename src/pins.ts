import type { Pins } from "@helia/interface";
import drain from "it-drain";
import type { CID } from "multiformats/cid";
import type { IpnsKey } from "./stream.js";

// these need concurrency control over Pins per CID
// check if Pins already does this
export async function pin(
	pins: Pins,
	pinner: IpnsKey,
	root: CID,
): Promise<void> {
	const now = Date.now();
	try {
		await drain(pins.add(root, { metadata: { [pinner.toString()]: now } }));
	} catch (e) {
		if (e instanceof Error && e.name === "AlreadyPinnedError") {
			const { metadata } = await pins.get(root);
			metadata[pinner.toString()] = now;
			await pins.setMetadata(root, metadata);
		} else {
			throw e;
		}
	}
}

export async function unpin(
	pins: Pins,
	pinner: IpnsKey,
	prevRoot: CID,
): Promise<void> {
	const { metadata } = await pins.get(prevRoot);

	if (metadata[pinner.toString()]) {
		delete metadata[pinner.toString()];
	}

	if (Object.keys(metadata).length > 0) {
		await pins.setMetadata(prevRoot, metadata);
	} else {
		await drain(pins.rm(prevRoot));
	}
}
