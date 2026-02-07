import "dotenv/config";
import { car } from "@helia/car";
import { globSource, unixfs } from "@helia/unixfs";
import { privateKeyFromProtobuf } from "@libp2p/crypto/keys";
import type { Libp2p, PrivateKey } from "@libp2p/interface";
import { enable, logger } from "@libp2p/logger";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { type Multiaddr, multiaddr } from "@multiformats/multiaddr";
import { ipns } from "@tabcat/helia-ipns";
import { LevelBlockstore } from "blockstore-level";
import { MemoryDatastore } from "datastore-core";
import { createHelia, type DefaultLibp2pServices } from "helia";
import type { Libp2pOptions } from "libp2p";
import { base36 } from "multiformats/bases/base36";
import type { CID } from "multiformats/cid";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { ZZZYNC, ZZZYNC_PROTOCOL_ID } from "../constants.js";
import { zzzync } from "../stream.js";
import type { PushConfig } from "./default-push-config.js";
import type { SubCommand } from "./index.js";
import { command } from "./index.js";

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      /**
       * Base64 encoded Libp2p Private Key Protobuf
       */
      PUBLISHER_KEY?: string;

      /**
       * Comma separated multiaddr strings (<multiaddr>,<multiaddr>)
       */
      MULTIADDRS?: string;
    }
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));

const PUSH_NAMESPACE = `${ZZZYNC}:push*`;
const log = logger(PUSH_NAMESPACE);

let enabled = `${PUSH_NAMESPACE}`;
if (process.env.DEBUG != null) {
  enabled = `${process.env.DEBUG},${enabled}`;
}
enable(enabled);

// reassigned later inside of run
export let cleanup: SubCommand["cleanup"] = () => {};

export const run: SubCommand["run"] = async (args: string[]) => {
  const { values, positionals } = parseArgs({
    args,
    options: { config: { default: `./.${command}`, type: "string" } },
    strict: true,
    allowPositionals: true,
  });

  let upload: string | null = null;
  try {
    for (const partial of positionals) {
      upload = resolve(partial);
      break;
    }
  } catch (e) {
    console.error("error while parsing file paths");
    throw e;
  }

  if (upload == null) {
    throw new Error("no files specified to push.");
  }

  if (process.env.PUBLISHER_KEY == null) {
    throw new Error(
      "Did not find PUBLISHER_KEY in env. Use zzzync generate to create one. Then add to environment.",
    );
  }

  let publisherKey: PrivateKey;
  try {
    publisherKey = privateKeyFromProtobuf(
      base36.decode(process.env.PUBLISHER_KEY),
    );
  } catch (e) {
    console.error(
      "failed to parse PUBLISHER_KEY. Use zzzync generate to create one.",
    );
    throw e;
  }

  if (process.env.MULTIADDRS == null) {
    throw new Error("no multiaddr provided");
  }

  const multiaddrs: Multiaddr[] = [];
  try {
    for (const addr of process.env.MULTIADDRS.split(",")) {
      multiaddrs.push(multiaddr(addr));
    }
  } catch (e) {
    console.error(
      "failed to parse MULTIADDRS. Use zzzync daemon --multiaddrs to print them.",
    );
    throw e;
  }

  if (
    !values.config.endsWith(`/.${command}`) && values.config !== `.${command}`
  ) {
    throw new Error(`--dir directory must be named ".${command}"`);
  }
  const CONFIG_DIR = resolve(values.config);
  await mkdir(CONFIG_DIR, { recursive: true });

  const datastore = new MemoryDatastore();
  const blockstore = new LevelBlockstore(join(CONFIG_DIR, "push/blockstore"));

  const DEFAULT_CONFIG_PATH = join(__dirname, "default-push-config.js");
  const CUSTOM_CONFIG_PATH = join(CONFIG_DIR, "push-config.js");
  const CONFIG_PATH = existsSync(CUSTOM_CONFIG_PATH)
    ? CUSTOM_CONFIG_PATH
    : DEFAULT_CONFIG_PATH;
  const config: PushConfig = await import(CONFIG_PATH);

  const peerId = peerIdFromPrivateKey(publisherKey);

  const libp2p: Libp2pOptions<DefaultLibp2pServices> =
    config.libp2pOptions != null
      ? config.libp2pOptions
      : (await import(DEFAULT_CONFIG_PATH)).libp2p;

  const helia = await createHelia<Libp2p<DefaultLibp2pServices>>({
    blockstore,
    datastore,
    libp2p: { ...libp2p, peerId },
    start: false,
  });
  const controller = new AbortController();
  const signal = controller.signal;
  cleanup = async () => {
    controller.abort();
    log("stopping helia...");
    await helia.stop();
    log("helia stopped.");
  };
  await config?.beforeStart?.(helia);

  log("starting helia...");
  await helia.start();
  log("helia started.");

  log("dialing multiaddrs");
  const stream = await helia.libp2p.dialProtocol(
    multiaddrs,
    ZZZYNC_PROTOCOL_ID,
    { signal },
  );
  log("dialed protocol");

  const importer = unixfs(helia);

  log("resolved path is", upload);
  const entry = await stat(upload);
  log("path is for directory");

  let root: CID | null = null;
  if (entry.isDirectory()) {
    for await (
      const imported of importer.addAll(globSource(upload, "**/*"), {
        signal,
        wrapWithDirectory: true,
      })
    ) {
      log.trace(imported);
      root = imported.cid;
    }

    if (root == null) {
      throw new Error("Did not find any files or folders to import.");
    }
  } else if (entry.isFile()) {
    root = await importer.addByteStream(createReadStream(upload), { signal });
  } else {
    throw new Error("Given path is not a file or directory.");
  }

  const names = ipns(helia);
  const exporter = car(helia);

  await helia.libp2p.services.keychain.importKey("publisher", publisherKey);
  const published = await names.publish("publisher", root, {
    offline: true,
    signal,
    upkeep: "none",
  });
  log("created new ipns record");

  log("attempting to zzzync!");
  await zzzync(stream, exporter, published, { signal });
  log("woah we just zzzynced!");

  await helia.stop();
};
