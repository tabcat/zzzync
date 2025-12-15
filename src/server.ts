import { type CarComponents, car } from "@helia/car";
import type { Routing } from "@helia/interface";
import { type IPNSComponents, ipns } from "@helia/ipns";
import type {
	ComponentLogger,
	Libp2p,
	StreamHandlerOptions,
} from "@libp2p/interface";
import type { Blockstore } from "interface-blockstore";
import type { Datastore } from "interface-datastore";
import { IPFS_PREFIX, IPNS_PREFIX, ZZZYNC_PROTOCOL_ID } from "./constants.js";
import { type CreateHandlerOptions, createHandler } from "./handler.js";
import type { ZzzyncServices } from "./interface.js";
import { createBlockstoreLookup, createIpnsRecordLookup } from "./lookups.js";

export interface ZzzyncServerComponents extends CarComponents, IPNSComponents {
	datastore: Datastore;
	blockstore: Blockstore;
	routing: Routing;
	logger: ComponentLogger;
	libp2p: Libp2p<ZzzyncServices>;
}

interface RegisterHandlersOptions
	extends CreateHandlerOptions,
		StreamHandlerOptions {}

export const registerHandlers = (
	components: ZzzyncServerComponents,
	options: RegisterHandlersOptions = {},
): { unregisterHandlers: () => void } => {
	const ipnsRecordLookup = createIpnsRecordLookup(components);
	const blockstoreLookup = createBlockstoreLookup(components);

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
		createHandler(ipns(components), car(components), options),
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
