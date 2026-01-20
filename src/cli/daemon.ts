import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { Helia } from "@helia/interface";
import type { Libp2p } from "@libp2p/interface";
import { enable, logger } from "@libp2p/logger";
import { LevelBlockstore } from "blockstore-level";
import { LevelDatastore } from "datastore-level";
import type { DefaultLibp2pServices } from "helia";
import type { Libp2pOptions } from "libp2p";
import { ZZZYNC } from "../constants.js";
import {
	createZzzyncServer,
	type RegisterHandlersOptions,
	type ZzzyncServices,
} from "../server.js";
import { HANDLER_NAMESPACE } from "../stream.js";
import type { SubCommand } from "./index.js";
import { command } from "./index.js";

const DAEMON_NAMESPACE = `${ZZZYNC}:daemon`;
const log = logger(DAEMON_NAMESPACE);
enable(DAEMON_NAMESPACE);
enable(HANDLER_NAMESPACE);

interface Config {
	beforeStart?: (helia: Helia<Libp2p<ZzzyncServices>>) => Promise<void>;
	libp2p?: Libp2pOptions<ZzzyncServices>;
	handlerOptions?: RegisterHandlersOptions;
}

export let cleanup: SubCommand["cleanup"] = () => {};

export const run: SubCommand["run"] = async (args: string[]) => {
	const { values } = parseArgs({
		args,
		options: {
			dir: {
				default: `./.${command}`,
				type: "string",
			},
		},
		strict: true,
	});

	if (!values.dir.endsWith(`/.${command}`) && values.dir !== `.${command}`) {
		throw new Error(`--dir directory must be named ".${command}"`);
	}
	const CONFIG_DIR = resolve(values.dir);
	await mkdir(CONFIG_DIR, { recursive: true });

	const datastore = new LevelDatastore(join(CONFIG_DIR, "datastore"));
	const blockstore = new LevelBlockstore(join(CONFIG_DIR, "blockstore"));

	const DEFAULT_CONFIG_PATH = "./default-config.js";
	const CUSTOM_CONFIG_PATH = join(CONFIG_DIR, "daemon-config.js");
	const CONFIG_PATH = existsSync(CUSTOM_CONFIG_PATH)
		? CUSTOM_CONFIG_PATH
		: DEFAULT_CONFIG_PATH;
	const config: Config = await import(CONFIG_PATH);

	const libp2p:
		| Libp2pOptions<ZzzyncServices>
		| Libp2pOptions<DefaultLibp2pServices & ZzzyncServices> =
		config.libp2p != null
			? config.libp2p
			: (await import(DEFAULT_CONFIG_PATH)).libp2p;

	const helia = await createZzzyncServer(
		{
			blockstore,
			datastore,
			libp2p,
			start: false,
		},
		config.handlerOptions,
	);
	cleanup = async () => {
		log("stopping helia...");
		await helia.stop();
		log("helia stopped.");
	};
	await config?.beforeStart?.(helia);

	log("starting helia...");
	await helia.start();
	log("helia started.");

	log(helia.libp2p.peerId);
	for (const addr of helia.libp2p.getMultiaddrs()) {
		log(addr);
	}

	log("ready to zzzync!");
};
