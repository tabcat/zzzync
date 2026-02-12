import { privateKeyFromProtobuf } from "@libp2p/crypto/keys";
import { PrivateKey } from "@libp2p/interface";
import { logger } from "@libp2p/logger";
import { Multiaddr, multiaddr } from "@multiformats/multiaddr";
import { LevelBlockstore } from "blockstore-level";
import { LevelDatastore } from "datastore-level";
import { Blockstore } from "interface-blockstore";
import { Datastore } from "interface-datastore";
import { base36 } from "multiformats/bases/base36";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SupportedPrivateKey } from "../challenge.js";
import { ZZZYNC } from "../constants.js";

const log = logger(`${ZZZYNC}/cli/utils`);

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      /**
       * Base64 encoded Libp2p Private Key Protobuf for Publisher IPNS
       */
      ZZZYNC_PUBLISHER_KEY?: string;

      /**
       * Base64 encoded Libp2p Private Key Protobuf for Daemon PeerId
       */
      ZZZYNC_DAEMON_KEY?: string;

      /**
       * Comma separated multiaddr strings (<multiaddr>,<multiaddr>)
       */
      MULTIADDRS?: string;
    }
  }
}

export const parseMultiaddrs = (): Multiaddr[] => {
  if (process.env.MULTIADDRS == null) return [];

  try {
    const multiaddrs: Multiaddr[] = [];
    for (const addr of process.env.MULTIADDRS.split(",")) {
      const ma = multiaddr(addr);
      multiaddrs.push(ma);
    }
    return multiaddrs;
  } catch (e) {
    log.error("failed to parse multiaddrs");
    throw e;
  }
};

export const parsePrivateKey = (
  space: "daemon" | "upload",
): SupportedPrivateKey => {
  const variable = space === "daemon"
    ? "ZZZYNC_DAEMON_KEY"
    : "ZZZYNC_PUBLISHER_KEY";
  const value = process.env[variable];

  if (value == null) {
    throw new Error(`environment variable ${variable} is not defined`);
  }

  let sk: PrivateKey;
  try {
    sk = privateKeyFromProtobuf(base36.decode(value));
  } catch (e) {
    throw new Error(`Failed to parse environment variable ${variable}`);
  }

  if (sk.type !== "Ed25519" && sk.type !== "secp256k1") {
    throw new Error("Unsupported key type");
  }

  return sk;
};

export const setupConfig = async (
  dir: string,
  space: "daemon" | "upload",
): Promise<
  { CONFIG_PATH: string; blockstore: Blockstore; datastore: Datastore; }
> => {
  const CONFIG_DIR = resolve(dir);
  await mkdir(CONFIG_DIR, { recursive: true });

  const datastore = new LevelDatastore(join(CONFIG_DIR, `${space}/datastore`));
  const blockstore = new LevelBlockstore(
    join(CONFIG_DIR, `${space}/blockstore`),
  );

  const CONFIG_PATH = join(__dirname, `${space}-config.js`);

  return { CONFIG_PATH, datastore, blockstore };
};
