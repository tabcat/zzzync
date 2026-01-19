#!/usr/bin/env node

import type { AbortOptions } from "@libp2p/interface";
import { ZZZYNC } from "../constants.js";

export const command = ZZZYNC;
export interface SubCommand {
	run: (args: string[], options?: AbortOptions) => unknown;
	cleanup?: () => unknown;
}

let [cmd, ...rest] = process.argv.slice(2);

if (cmd == null || cmd === "h" || cmd === "-h") {
	cmd = "help";
}

const HELP_MESSAGE = `
Use 'zzzync daemon' or 'zzzync push'
`;

const help: SubCommand = {
	cleanup: () => {},
	run: (_args: string[]) => console.log(HELP_MESSAGE),
};

let subcommand: SubCommand | null = null;
switch (cmd) {
	case "daemon": {
		subcommand = (await import("./daemon.js")) as SubCommand;
		break;
	}
	case "push": {
		subcommand = (await import("./push.js")) as SubCommand;
		break;
	}
	case "help": {
		subcommand = help;
		break;
	}
}

if (subcommand == null) {
	throw new Error(`Unrecognized command: ${cmd}`);
}

const controller = new AbortController();
let stopping: Promise<void> | false = false;
function stop() {
	if (!stopping)
		stopping = (async () => {
			try {
				await subcommand?.cleanup?.();
			} catch (e) {
				console.error("Failed while running cleanup");
				console.error(e);
				process.exitCode = 1;
			}
		})();
	return stopping;
}
process.once("SIGINT", async () => {
	process.exitCode = 130;
	controller.abort("SIGINT");
	await stop();
	process.exit();
});
process.once("SIGTERM", async () => {
	process.exitCode = 143;
	controller.abort("SIGTERM");
	await stop();
	process.exit();
});

try {
	await subcommand.run(rest, { signal: controller.signal });
} catch (e) {
	console.error(e);
} finally {
	await stop();
}
