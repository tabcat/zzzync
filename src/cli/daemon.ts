import { enable, logger } from "@libp2p/logger";
import { LevelBlockstore } from "blockstore-level";
import { LevelDatastore } from "datastore-level";
import type { DefaultLibp2pServices } from "helia";
import type { Libp2pOptions } from "libp2p";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ZZZYNC } from "../constants.js";
import { createZzzyncServer, type ZzzyncServices } from "../server.js";
import { HANDLER_NAMESPACE } from "../stream.js";
import type { DaemonConfig } from "./default-daemon-config.js";
import type { SubCommand } from "./index.js";
import { command } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DAEMON_NAMESPACE = `${ZZZYNC}:daemon`;
const log = logger(DAEMON_NAMESPACE);

let enabled = `${DAEMON_NAMESPACE}*,${HANDLER_NAMESPACE}*`;
if (process.env.DEBUG != null) {
  enabled = `${process.env.DEBUG},${enabled}`;
}
enable(enabled);

// reassigned later inside of run
export let cleanup: SubCommand["cleanup"] = () => {};

export const run: SubCommand["run"] = async (args: string[]) => {
  const { values } = parseArgs({
    args,
    options: {
      config: {
        default: `./.${command}`,
        type: "string",
      },
    },
    strict: true,
  });

  if (
    !values.config.endsWith(`/.${command}`)
    && values.config !== `.${command}`
  ) {
    throw new Error(`--config directory must be named ".${command}"`);
  }
  const CONFIG_DIR = resolve(values.config);
  await mkdir(CONFIG_DIR, { recursive: true });

  const datastore = new LevelDatastore(join(CONFIG_DIR, "daemon/datastore"));
  const blockstore = new LevelBlockstore(join(CONFIG_DIR, "daemon/blockstore"));

  const DEFAULT_CONFIG_PATH = join(__dirname, "default-daemon-config.js");
  const CUSTOM_CONFIG_PATH = join(CONFIG_DIR, "daemon-config.js");
  const CONFIG_PATH = existsSync(CUSTOM_CONFIG_PATH)
    ? CUSTOM_CONFIG_PATH
    : DEFAULT_CONFIG_PATH;
  const config: DaemonConfig = await import(CONFIG_PATH);

  const libp2p:
    | Libp2pOptions<ZzzyncServices>
    | Libp2pOptions<DefaultLibp2pServices & ZzzyncServices> =
      config.libp2pOptions != null
        ? config.libp2pOptions
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
