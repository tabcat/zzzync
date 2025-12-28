#!/usr/bin/env node

/**
 * This simple cli tool is made easy to fork and extend.
*/

import { access, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { fetch } from "@libp2p/fetch";
import type { Libp2p } from "@libp2p/interface";
import { LevelBlockstore } from "blockstore-level";
import { LevelDatastore } from "datastore-level";
import { createHelia, type DefaultLibp2pServices, libp2pDefaults } from "helia";
import type { AddressManagerInit, Libp2pOptions } from "libp2p";
import { registerHandlers, type ZzzyncServices } from "./server.js";

const command = "zzzync";

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

interface Config {
	addresses: Omit<AddressManagerInit, "announceFilter">;
}

async function daemon() {
	try {
		const { values } = parseArgs({
			args: rest,
			options: {
				dir: {
					default: `./.${command}`,
					type: "string",
				},
			},
			strict: true,
		});

		if (!values.dir.endsWith(`/.${command}`) && values.dir !== `.${command}`) {
			throw new Error(`--dir option must end with "/.${command}" or ".${command}"`)
		}

		const CONFIG_DIR = values.dir;
		const configExists: boolean = await access(`${CONFIG_DIR}/config.json`)
			.then(() => true)
			.catch(() => false);

		const defaultLibp2pOptions = libp2pDefaults();

		let config: Config;
		if (configExists) {
			console.log("reading config...");
			config = await readFile(`${CONFIG_DIR}/config.json`, "utf8").then(
				(string) => JSON.parse(string),
			);
			console.log(`read config from ${CONFIG_DIR}/config.json.`);
		} else {
			config = {
				addresses: {
					listen: defaultLibp2pOptions.addresses?.listen ?? [],
				},
			};
			console.log(`writing config...`);
			await writeFile(
				`${CONFIG_DIR}/config.json`,
				JSON.stringify(config, null, 2),
				"utf8",
			);
			console.log(`wrote config to ${CONFIG_DIR}/config.json.`);
		}

		const datastore = new LevelDatastore(`${CONFIG_DIR}/datastore`);
		const blockstore = new LevelBlockstore(`${CONFIG_DIR}/blockstore`);
		const libp2p: Libp2pOptions<DefaultLibp2pServices & ZzzyncServices> = {
			...defaultLibp2pOptions,
			...config,
			datastore,
			services: {
				...defaultLibp2pOptions.services,
				fetch: fetch(),
			},
		};

		const helia = await createHelia<
			Libp2p<DefaultLibp2pServices & ZzzyncServices>
		>({ blockstore, datastore, libp2p, start: false });
		cleanup = async () => {
			console.log("stopping helia...");
			await helia.stop();
			console.log("helia stopped.");
		};
		registerHandlers(helia);

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
