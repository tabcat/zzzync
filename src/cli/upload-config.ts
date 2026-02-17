import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { tcp } from "@libp2p/tcp";

import { fetch } from "@libp2p/fetch";
import { keychain } from "@libp2p/keychain";
import type { Helia } from "helia";
import type { Libp2p, Libp2pOptions } from "libp2p";
import { ZzzyncServices } from "../server.js";

export interface UploadConfig<T extends ZzzyncServices = ZzzyncServices> {
  /**
   * A function to run before helia is started.
   *
   * @param helia
   * @returns
   */
  beforeStart?: (helia: Helia<Libp2p<T>>) => Promise<void>;

  /**
   * The libp2p options to use
   */
  libp2pOptions: Libp2pOptions<T>;
}

export const libp2pOptions: UploadConfig["libp2pOptions"] = {
  addresses: { listen: ["/ip4/127.0.0.1/tcp/4100"] },
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  transports: [tcp()],
  services: { fetch: fetch(), keychain: keychain() },
};
