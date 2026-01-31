import { createReadStream, existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { car } from "@helia/car";
import { globSource, unixfs } from "@helia/unixfs";
import type { Libp2p } from "@libp2p/interface";
import { enable, logger } from "@libp2p/logger";
import { peerIdFromPublicKey } from "@libp2p/peer-id";
import { type Multiaddr, multiaddr } from "@multiformats/multiaddr";
import { ipns } from "@tabcat/helia-ipns";
import { LevelBlockstore } from "blockstore-level";
import { LevelDatastore } from "datastore-level";
import { createHelia, type DefaultLibp2pServices } from "helia";
import type { Libp2pOptions } from "libp2p";
import type { CID } from "multiformats/cid";
import { ZZZYNC, ZZZYNC_PROTOCOL_ID } from "../constants.js";
import { zzzync } from "../stream.js";
import type { PushConfig } from "./default-push-config.js";
import type { SubCommand } from "./index.js";
import { command } from "./index.js";

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
  const { values } = parseArgs({
    args,
    options: {
      config: {
        default: `./.${command}`,
        type: "string",
      },
      keyname: {
        default: "self",
        type: "string",
      },
      multiaddr: {
        multiple: true,
        type: "string",
      },
      upload: {
        type: "string",
      },
    },
    strict: true,
  });

  if (values.multiaddr == null) {
    throw new Error("no multiaddr provided");
  }

  if (values.upload == null) {
    throw new Error("no upload path provided");
  }

  if (
    !values.config.endsWith(`/.${command}`) &&
    values.config !== `.${command}`
  ) {
    throw new Error(`--dir directory must be named ".${command}"`);
  }
  const CONFIG_DIR = resolve(values.config);
  await mkdir(CONFIG_DIR, { recursive: true });

  const datastore = new LevelDatastore(join(CONFIG_DIR, "push/datastore"));
  const blockstore = new LevelBlockstore(join(CONFIG_DIR, "push/blockstore"));

  const DEFAULT_CONFIG_PATH = join(__dirname, "default-push-config.js");
  const CUSTOM_CONFIG_PATH = join(CONFIG_DIR, "push-config.js");
  const CONFIG_PATH = existsSync(CUSTOM_CONFIG_PATH)
    ? CUSTOM_CONFIG_PATH
    : DEFAULT_CONFIG_PATH;
  const config: PushConfig = await import(CONFIG_PATH);

  const libp2p: Libp2pOptions<DefaultLibp2pServices> =
    config.libp2pOptions != null
      ? config.libp2pOptions
      : (await import(DEFAULT_CONFIG_PATH)).libp2p;

  const helia = await createHelia<Libp2p<DefaultLibp2pServices>>({
    blockstore,
    datastore,
    libp2p,
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

  const multiaddrs: Multiaddr[] = [];
  for (const addr of values.multiaddr) {
    multiaddrs.push(multiaddr(addr));
  }

  log("dialing multiaddrs");
  const stream = await helia.libp2p.dialProtocol(
    multiaddrs,
    ZZZYNC_PROTOCOL_ID,
    { signal },
  );
  log("dialed protocol");

  const importer = unixfs(helia);

  const path = resolve(values.upload);
  log("resolved path is", path);
  const entry = await stat(path);
  log("path is for directory");

  let root: CID | null = null;
  if (entry.isDirectory()) {
    for await (const imported of importer.addAll(globSource(path, "**/*"), {
      signal,
      wrapWithDirectory: true,
    })) {
      log.trace(imported);
      root = imported.cid;
    }

    if (root == null) {
      throw new Error("Did not find any files or folders to import.");
    }
  } else if (entry.isFile()) {
    root = await importer.addByteStream(createReadStream(path), { signal });
  } else {
    throw new Error("Given path is not a file or directory.");
  }

  const exporter = car(helia);

  const names = ipns(helia);
  const published = await names.publish(values.keyname, root, {
    offline: true,
    signal,
  });
  log("created new ipns record");

  const peerId = peerIdFromPublicKey(published.publicKey);

  if (peerId.type === "RSA" || peerId.type === "url") {
    throw new Error("peerId type not supported.");
  }

  log("attempting to zzzync!");
  await zzzync(stream, exporter, peerId.toCID(), published.record, root, {
    signal,
  });
  log("woah we just zzzynced!");

  await helia.stop();
};
