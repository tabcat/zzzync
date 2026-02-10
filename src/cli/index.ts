#!/usr/bin/env node

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ZZZYNC } from "../constants.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const command = ZZZYNC;
export interface SubCommand {
  run: (args: string[]) => unknown;
  cleanup?: () => unknown;
}

let [cmd, ...rest] = process.argv.slice(2);

if (cmd == null || cmd === "h" || cmd === "-h") {
  cmd = "help";
}

const HELP_MESSAGE = `
Use 'zzzync daemon' or 'zzzync upload'
`;

const help: SubCommand = {
  cleanup: () => {},
  run: (_args: string[]) => console.log(HELP_MESSAGE),
};

(async () => {
  let subcommand: SubCommand | null = null;
  switch (cmd) {
    case "daemon": {
      subcommand = (await import(join(__dirname, "daemon.js"))) as SubCommand;
      break;
    }
    case "upload": {
      subcommand = (await import(join(__dirname, "upload.js"))) as SubCommand;
      break;
    }
    case "generate": {
      subcommand = (await import(join(__dirname, "generate.js"))) as SubCommand;
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

  let stopping: Promise<void> | false = false;
  function stop() {
    if (!stopping) {
      stopping = (async () => {
        try {
          await subcommand?.cleanup?.();
        } catch (e) {
          console.error("Failed while running cleanup");
          console.error(e);
          process.exitCode = 1;
        }
      })();
    }
    return stopping;
  }
  process.once("SIGINT", async () => {
    process.exitCode = 130;
    await stop();
    process.exit();
  });
  process.once("SIGTERM", async () => {
    process.exitCode = 143;
    await stop();
    process.exit();
  });
  process.on("unhandledRejection", (reason) => {
    console.error(reason);
  });

  try {
    await subcommand.run(rest);
  } catch (e) {
    console.error(e);
    await stop();
  }
})();
