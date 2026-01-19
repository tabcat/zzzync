#!/usr/bin/env node

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { Helia } from "@helia/interface";
import { fetch } from "@libp2p/fetch";
import type { Libp2p } from "@libp2p/interface";
import { LevelBlockstore } from "blockstore-level";
import { LevelDatastore } from "datastore-level";
import { type DefaultLibp2pServices, libp2pDefaults } from "helia";
import type { AddressManagerInit, Libp2pOptions } from "libp2p";
import {
	createZzzyncServer,
	type RegisterHandlersOptions,
	type ZzzyncServices,
} from "./server.js";

const command = "zzzync";

interface Config {
	beforeStart?: (helia: Helia<Libp2p<ZzzyncServices>>) => Promise<void>;
	libp2p?: Libp2pOptions<ZzzyncServices>;
	handlerOptions?: RegisterHandlersOptions;
}

interface Addresses {
	addresses: Omit<AddressManagerInit, "announceFilter">;
}

let stopping = false;
let cleanup = async () => {};
process.on("SIGINT", async () => {
	console.log(""); // newline after ^C printed
	if (stopping === true) {
		return;
	}
	stopping = true;

	try {
		await cleanup();
		console.log("process should exit soon.");
	} finally {
		process.exitCode = 130;
	}
});

let [cmd, ...rest] = process.argv.slice(2);

if (cmd == null || cmd === "h" || cmd === "-h") {
	cmd = "help";
}

switch (cmd) {
	case "daemon": {
		daemon();
		break;
	}
	case "help": {
		help();
		break;
	}
	default:
		throw new Error(`Unrecognized command: ${cmd}`);
}

async function daemon() {
	try {
		const { values } = parseArgs({
			args: rest,
			options: {
				config: {
					type: "string",
				},
				dir: {
					default: `./.${command}`,
					type: "string",
				},
			},
			strict: true,
		});

		if (!values.dir.endsWith(`/.${command}`) && values.dir !== `.${command}`) {
			throw new Error(
				`--dir option must end with "/.${command}" or ".${command}"`,
			);
		}
		const CONFIG_DIR = values.dir;
		const configExists: boolean = await access(`${CONFIG_DIR}/addresses.json`)
			.then(() => true)
			.catch(() => false);
		const datastore = new LevelDatastore(`${CONFIG_DIR}/datastore`);
		const blockstore = new LevelBlockstore(`${CONFIG_DIR}/blockstore`);

		let extension: Config | undefined;
		if (values.config) {
			extension = await import(values.config);
		}
		const libp2p:
			| Libp2pOptions<ZzzyncServices>
			| Libp2pOptions<DefaultLibp2pServices & ZzzyncServices> =
			extension?.libp2p
				? { ...extension.libp2p, datastore }
				: {
						...libp2pDefaults(),
						datastore,
						services: {
							...libp2pDefaults().services,
							fetch: fetch(),
						},
					};

		let config: Addresses;
		if (configExists) {
			console.log("reading config...");
			config = await readFile(`${CONFIG_DIR}/addresses.json`, "utf8").then(
				(string) => JSON.parse(string),
			);
			console.log(`read config from ${CONFIG_DIR}/addresses.json.`);
		} else {
			config = {
				addresses: {
					listen: libp2p.addresses?.listen ?? [],
				},
			};
			console.log(`writing config...`);
			await mkdir(CONFIG_DIR, { recursive: true });
			await writeFile(
				`${CONFIG_DIR}/addresses.json`,
				JSON.stringify(config, null, 2),
				"utf8",
			);
			console.log(`wrote config to ${CONFIG_DIR}/addresses.json.`);
		}

		const helia = await createZzzyncServer(
			{
				blockstore,
				datastore,
				libp2p,
				start: false,
			},
			extension?.handlerOptions,
		);
		cleanup = async () => {
			console.log("stopping helia...");
			await helia.stop();
			console.log("helia stopped.");
		};

		if (extension?.beforeStart) {
			await extension.beforeStart(helia);
		}

		console.log("starting helia...");
		await helia.start();
		console.log("helia started.");

		console.log(helia.libp2p.peerId);
		for (const addr of helia.libp2p.getMultiaddrs()) {
			console.log(addr);
		}

		console.log("ready to zzzync!");
	} catch (e) {
		console.error(e);
		process.exitCode = 1;
	}
}

async function help() {
	console.log(`Just use ${command} daemon.`);
}
