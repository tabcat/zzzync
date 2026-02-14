import "dotenv/config";
import { car } from "@helia/car";
import { globSource, unixfs } from "@helia/unixfs";
import type { Libp2p } from "@libp2p/interface";
import { enable, logger } from "@libp2p/logger";
import { ipns } from "@tabcat/helia-ipns";
import { createHelia } from "helia";
import type { CID } from "multiformats/cid";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createSign } from "../challenge.js";
import { ZZZYNC_PROTOCOL_ID } from "../constants.js";
import { UPLOAD_NAMESPACE, zzzync } from "../dialer.js";
import { fetchIpnsRecord } from "../libp2p-fetch/ipns.js";
import { ZzzyncServices } from "../server.js";
import { contenthash } from "../utils.js";
import type { SubCommand } from "./index.js";
import { command } from "./index.js";
import type { UploadConfig } from "./upload-config.js";
import { parseMultiaddrs, parsePrivateKey, setupConfig } from "./utils.js";

const keyName = "upload";

// enable logging
const log = logger(UPLOAD_NAMESPACE);
let enabled = `${UPLOAD_NAMESPACE}, ${UPLOAD_NAMESPACE}:*`;
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

  // get upload path
  let upload: string | null = null;
  try {
    // just support single path uploads for now
    for (const partial of positionals) {
      upload = resolve(partial);
      break;
    }
    if (upload == null) {
      throw new Error("no files specified to upload.");
    }
  } catch (e) {
    console.error("error while parsing file paths");
    throw e;
  }

  // parse multiaddrs
  const multiaddrs = parseMultiaddrs();
  if (multiaddrs.length === 0) {
    throw new Error("No multiaddrs provided");
  }

  if (
    !values.config.endsWith(`/.${command}`) && values.config !== `.${command}`
  ) {
    throw new Error(`--config directory must be named ".${command}"`);
  }
  const CONFIG_DIR = resolve(values.config);
  const { CONFIG_PATH, datastore, blockstore } = await setupConfig(
    CONFIG_DIR,
    "upload",
  );
  const config: UploadConfig<ZzzyncServices> = await import(CONFIG_PATH);

  const libp2pOptions = config.libp2pOptions;

  const helia = await createHelia<Libp2p<ZzzyncServices>>({
    blockstore,
    datastore,
    libp2p: libp2pOptions,
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

  const libp2p = helia.libp2p;

  const publisherKey = parsePrivateKey("upload");
  try {
    await libp2p.services.keychain.removeKey(keyName);
  } catch {}
  await libp2p.services.keychain.importKey(keyName, publisherKey);
  log("imported private key");
  log("starting upload to contenthash %s", contenthash(publisherKey.publicKey));

  await config?.beforeStart?.(helia);
  log("starting helia...");
  await helia.start();
  log("helia started.");

  const importer = unixfs(helia);

  log("resolved path is %s", upload);
  const entry = await stat(upload);

  let root: CID | null = null;
  log("importing %s to unixfs", upload);
  if (entry.isDirectory()) {
    log("path is to directory");
    for await (
      const imported of importer.addAll(globSource(upload, "**/*"), { signal })
    ) {
      log.trace(imported);
      root = imported.cid;
    }

    if (root == null) {
      throw new Error("Did not find any files or folders to import.");
    }
  } else if (entry.isFile()) {
    log("path is to file");
    root = await importer.addByteStream(createReadStream(upload), { signal });
  } else {
    throw new Error("upload path is not a file or directory.");
  }
  log("imported %s into unixfs", upload);

  const names = ipns(helia);
  const exporter = car(helia);

  log("dialing multiaddrs");
  const connection = await libp2p.dial(multiaddrs, { signal });
  const handlerPeerId = connection.remotePeer;
  log("dial complete");

  log("fetching ipns record from zzzync handler");
  const dialerIpns = publisherKey.publicKey.toMultihash();
  const fetch = libp2p.services.fetch.fetch.bind(libp2p.services.fetch);
  const handlerRecord = await fetchIpnsRecord(
    fetch,
    handlerPeerId,
    dialerIpns,
    { signal },
  );
  if (handlerRecord) {
    log("importing record from handler");
    await names.republish(dialerIpns, {
      offline: true,
      upkeep: "none",
      record: handlerRecord,
      skipResolution: true,
    });
  } else {
    log("fetch did not find record on zzzync handler");
  }

  const published = await names.publish(keyName, root, {
    offline: true,
    signal,
    upkeep: "none",
  });
  log("created new ipns record");

  log("opening zzzync stream");
  const stream = await connection.newStream(ZZZYNC_PROTOCOL_ID, { signal });
  log("opened zzzync stream");

  log("attempting to zzzync...");
  await zzzync(
    stream,
    handlerPeerId,
    exporter,
    published,
    createSign(publisherKey),
    { signal },
  );
  log("woah we just zzzynced!");

  await helia.stop();
};
