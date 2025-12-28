import { type CarComponents, car } from "@helia/car";
import type { Pins, Routing } from "@helia/interface";
import { type IPNSComponents, ipns } from "@helia/ipns";
import type { Fetch } from "@libp2p/fetch";
import type {
	ComponentLogger,
	Libp2p,
	ServiceMap,
	StreamHandlerOptions,
} from "@libp2p/interface";
import type { Keychain } from "@libp2p/keychain";
import type { Blockstore } from "interface-blockstore";
import type { Datastore } from "interface-datastore";
import { IPFS_PREFIX, IPNS_PREFIX, ZZZYNC_PROTOCOL_ID } from "./constants.js";
import {
	type BlockLookupComponents,
	createBlockLookup,
} from "./libp2p-fetch/block.js";
import {
	createIpnsRecordLookup,
	type IpnsRecordLookupComponents,
} from "./libp2p-fetch/ipns.js";
import { type CreateHandlerOptions, createHandler } from "./stream.js";

export interface ZzzyncServices extends ServiceMap {
	fetch: Fetch;
	keychain: Keychain;
}

export interface ZzzyncServerComponents
	extends CarComponents,
		IPNSComponents,
		BlockLookupComponents,
		IpnsRecordLookupComponents {
	datastore: Datastore;
	blockstore: Blockstore;
	routing: Routing;
	logger: ComponentLogger;
	libp2p: Libp2p<ZzzyncServices>;
	pins: Pins;
}

interface RegisterHandlersOptions
	extends CreateHandlerOptions,
		StreamHandlerOptions {}

export const registerHandlers = (
	components: ZzzyncServerComponents,
	options: RegisterHandlersOptions = {},
): { unregisterHandlers: () => void } => {
	const ipnsRecordLookup = createIpnsRecordLookup(components);
	const blockstoreLookup = createBlockLookup(components);

	components.libp2p.services.fetch.registerLookupFunction(
		IPNS_PREFIX,
		ipnsRecordLookup,
	);
	components.libp2p.services.fetch.registerLookupFunction(
		IPFS_PREFIX,
		blockstoreLookup,
	);
	components.libp2p.handle(
		ZZZYNC_PROTOCOL_ID,
		createHandler(ipns(components), car(components), components.pins, options),
		options,
	);

	const unregisterHandlers = (): void => {
		components.libp2p.unuse(ZZZYNC_PROTOCOL_ID);
		components.libp2p.services.fetch.unregisterLookupFunction(
			IPNS_PREFIX,
			ipnsRecordLookup,
		);
		components.libp2p.services.fetch.unregisterLookupFunction(
			IPFS_PREFIX,
			blockstoreLookup,
		);
		components.libp2p.unhandle(ZZZYNC_PROTOCOL_ID);
	};

	return { unregisterHandlers };
};
