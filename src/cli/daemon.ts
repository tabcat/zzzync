import "dotenv/config";
import { enable, logger } from "@libp2p/logger";
import { Multiaddr } from "@multiformats/multiaddr";
import type { Libp2pOptions } from "libp2p";
import { parseArgs } from "node:util";
import { SupportedPrivateKey } from "../challenge.js";
import { ZZZYNC } from "../constants.js";
import { HANDLER_NAMESPACE } from "../handler.js";
import { PINS_NAMESPACE } from "../pins.js";
import { createZzzyncServer, type ZzzyncServices } from "../server.js";
import type { DaemonConfig } from "./daemon-config.js";
import type { SubCommand } from "./index.js";
import { command } from "./index.js";
import {
  detectUpdate,
  parseMultiaddrs,
  parsePrivateKey,
  setupConfig,
} from "./utils.js";

const DAEMON_NAMESPACE = `${ZZZYNC}:daemon`;
const log = logger(DAEMON_NAMESPACE);

let enabled = `${DAEMON_NAMESPACE}*,${HANDLER_NAMESPACE}*,${PINS_NAMESPACE}`;
if (process.env.DEBUG != null) {
  enabled = `${process.env.DEBUG},${enabled}`;
}
enable(enabled);

// reassigned later inside of run
export let cleanup: SubCommand["cleanup"] = () => {};

export const run: SubCommand["run"] = async (args: string[]) => {
  const { values } = parseArgs({
    args,
    options: { config: { default: `./.${command}`, type: "string" } },
    strict: true,
  });

  if (
    !values.config.endsWith(`/.${command}`) && values.config !== `.${command}`
  ) {
    throw new Error(`--config directory must be named ".${command}"`);
  }
  const { CONFIG_PATH, datastore, blockstore } = await setupConfig(
    values.config,
    "daemon",
  );
  const config: DaemonConfig = await import(CONFIG_PATH);

  const libp2p: Libp2pOptions<ZzzyncServices> = config.libp2pOptions;

  const envMultiaddrs = parseMultiaddrs();
  if (envMultiaddrs.length) {
    log("found environment multiaddrs");
    libp2p.addresses = {
      ...libp2p.addresses,
      listen: [...envMultiaddrs.map(String), "/p2p-circuit", "/webrtc"],
    };
  }

  const announce = process.env.ANNOUNCE?.split(",");
  if (announce?.length) {
    log("found environment announce addrs");
    libp2p.addresses = { ...libp2p.addresses, announce };
  }

  let privateKey: SupportedPrivateKey | null = null;
  try {
    privateKey = parsePrivateKey("daemon");
  } catch {}
  if (privateKey != null) {
    log("found environment daemon peer id");
    libp2p.privateKey = privateKey;
  }

  const helia = await createZzzyncServer({
    blockstore,
    datastore,
    libp2p,
    start: false,
  }, config.handlerOptions);
  helia.libp2p.addEventListener(
    "self:peer:update",
    ({ detail: { peer, previous } }) => {
      if (detectUpdate(peer, previous)) {
        console.log(`MULTIADDRS=${helia.libp2p.getMultiaddrs().join(",")}`);
      }
    },
  );

  cleanup = async () => {
    helia.libp2p.removeEventListener("self:peer:update");
    log("stopping helia...");
    await helia.stop();
    log("helia stopped.");
  };

  await config?.beforeStart?.(helia);

  log("starting helia...");
  await helia.start();
  log("helia started.");

  log(helia.libp2p.peerId);
  const multiaddrs: Multiaddr[] = [];
  for (const addr of helia.libp2p.getMultiaddrs()) {
    multiaddrs.push(addr);
    log(addr);
  }

  log("ready to zzzync!");

  // console.log(`MULTIADDRS=${multiaddrs.join(",")}`);
};
