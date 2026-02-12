import "dotenv/config";
import { car } from "@helia/car";
import { globSource, unixfs } from "@helia/unixfs";
import { generateKeyPair, privateKeyFromProtobuf } from "@libp2p/crypto/keys";
import { Fetch } from "@libp2p/fetch";
import type { Libp2p, PrivateKey } from "@libp2p/interface";
import { enable, logger } from "@libp2p/logger";
import { type Multiaddr, multiaddr } from "@multiformats/multiaddr";
import { ipns } from "@tabcat/helia-ipns";
import { LevelBlockstore } from "blockstore-level";
import { LevelDatastore } from "datastore-level";
import { createHelia, type DefaultLibp2pServices } from "helia";
import { base36 } from "multiformats/bases/base36";
import type { CID } from "multiformats/cid";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createSign, SupportedPrivateKey } from "../challenge.js";
import { ZZZYNC_PROTOCOL_ID } from "../constants.js";
import { UPLOAD_NAMESPACE, zzzync } from "../dialer.js";
import { fetchIpnsRecord } from "../libp2p-fetch/ipns.js";
import type { UploadConfig } from "./default-upload-config.js";
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

      /**
       * Used to detect if running inside a Github Action
       */
      GITHUB_ACTIONS?: string;
    }
  }
}

const publisherKeyName = "publisher";
const isGitHubAction = process.env.GITHUB_ACTIONS === "true";
const __dirname = dirname(fileURLToPath(import.meta.url));

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
    options: {
      config: { default: `./.${command}`, type: "string" },
      persisted: { default: false, type: "boolean" },
    },
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

  if (values.persisted) {
    console.log(
      "persisted option passed - this assumes the latest ipns record is always local",
    );
    if (isGitHubAction) {
      throw new Error("persisted flag is not allowed in Github Actions");
    }
  }

  // get multiaddrs
  const multiaddrs: Multiaddr[] = [];
  if (process.env.MULTIADDRS == null) {
    throw new Error("no multiaddr provided");
  }
  try {
    for (const addr of process.env.MULTIADDRS.split(",")) {
      const ma = multiaddr(addr);
      multiaddrs.push(ma);
      log("found multiaddr %a", ma);
    }
  } catch (e) {
    console.error(
      "failed to parse MULTIADDRS. Use zzzync daemon to print them.",
    );
    throw e;
  }

  // get config path
  if (
    !values.config.endsWith(`/.${command}`) && values.config !== `.${command}`
  ) {
    throw new Error(`--config directory must be named ".${command}"`);
  }
  const CONFIG_DIR = resolve(values.config);
  await mkdir(CONFIG_DIR, { recursive: true });

  const datastore = new LevelDatastore(join(CONFIG_DIR, "upload/datastore"));
  const blockstore = new LevelBlockstore(join(CONFIG_DIR, "upload/blockstore"));

  const DEFAULT_CONFIG_PATH = join(__dirname, "default-upload-config.js");
  const CUSTOM_CONFIG_PATH = join(CONFIG_DIR, "upload-config.js");
  const CONFIG_PATH = existsSync(CUSTOM_CONFIG_PATH)
    ? CUSTOM_CONFIG_PATH
    : DEFAULT_CONFIG_PATH;
  const config: UploadConfig = await import(CONFIG_PATH);

  const libp2pOptions: UploadConfig["libp2pOptions"] =
    config.libp2pOptions != null
      ? config.libp2pOptions
      : (await import(DEFAULT_CONFIG_PATH)).libp2p;

  const helia = await createHelia<
    Libp2p<DefaultLibp2pServices & { fetch: Fetch; }>
  >({ blockstore, datastore, libp2p: libp2pOptions, start: false });
  const controller = new AbortController();
  const signal = controller.signal;
  cleanup = async () => {
    controller.abort();
    log("stopping helia...");
    await helia.stop();
    log("helia stopped.");
  };

  const libp2p = helia.libp2p;

  // get publisher key
  let publisherKey: SupportedPrivateKey;
  try {
    let sk: PrivateKey;
    if (values.persisted) {
      log("persisted option passed - using datastore publisher key");
      try {
        sk = await libp2p.services.keychain.exportKey(publisherKeyName);
      } catch (e) {
        if (e instanceof Error && e.name === "NotFoundError") {
          // If no named key found in keychain, generate and import
          sk = await generateKeyPair("Ed25519");
        } else {
          throw e;
        }
      }
    } else if (process.env.PUBLISHER_KEY) {
      log("found PUBLISHER_KEY environment variable");

      sk = privateKeyFromProtobuf(base36.decode(process.env.PUBLISHER_KEY));
    } else {
      throw new Error(
        "Did not find PUBLISHER_KEY in env. Use zzzync generate to create one. Then add to environment.",
      );
    }

    if (sk.type !== "Ed25519" && sk.type !== "secp256k1") {
      throw new Error("Unsupported key type");
    }

    publisherKey = sk;
  } catch (e) {
    console.error(e);
    throw new Error("unable to find publisher key");
  }
  await libp2p.services.keychain.importKey(publisherKeyName, publisherKey);

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

  if (!values.persisted) {
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
      });
    } else {
      log("fetch did not find record");
    }
  } else {
    log("persisted option enabled - skipping fetch from zzzync handler");
  }

  const published = await names.publish("publisher", root, {
    offline: true,
    signal,
    upkeep: "none",
  });
  log("created new ipns record");

  log("opening zzzync stream");
  const stream = await connection.newStream(ZZZYNC_PROTOCOL_ID, { signal });
  log("opened zzzync stream");

  log("attempting to zzzync!");
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
