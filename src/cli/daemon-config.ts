import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { bootstrap } from "@libp2p/bootstrap";
import { fetch } from "@libp2p/fetch";
import { identify, identifyPush } from "@libp2p/identify";
import { kadDHT } from "@libp2p/kad-dht";
import { keychain } from "@libp2p/keychain";
import { ping } from "@libp2p/ping";
import { tcp } from "@libp2p/tcp";
import { ipnsSelector, ipnsValidator } from "@tabcat/helia-ipns";
import type { Helia } from "helia";
import type { Libp2p, Libp2pOptions } from "libp2p";
import { RegisterHandlersOptions, ZzzyncServices } from "../server.js";

export interface DaemonConfig<T extends ZzzyncServices = ZzzyncServices> {
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

  /**
   * Options for registration of the zzzync and fetch handlers
   */

  handlerOptions?: RegisterHandlersOptions;
}

export const libp2pOptions: DaemonConfig["libp2pOptions"] = {
  connectionEncrypters: [noise()],
  streamMuxers: [yamux()],
  transports: [tcp()],
  peerDiscovery: [bootstrap({
    list: [
      "/dnsaddr/bootstrap.libp2p.io/p2p/QmNnooDu7bfjPFoTZYxMNLWUQJyrVwtbZg5gBMjTezGAJN",
      "/dnsaddr/bootstrap.libp2p.io/p2p/QmbLHAnMoJPWSCR5Zhtx6BHJX9KiKNN6tpvbUcqanj75Nb",
      "/dnsaddr/bootstrap.libp2p.io/p2p/QmcZf59bWwK5XFi76CZX8cbJ4BhTzzA3gU1ZjYZcYW3dwt",
      // va1 is not in the TXT records for _dnsaddr.bootstrap.libp2p.io yet
      // so use the host name directly
      "/dnsaddr/va1.bootstrap.libp2p.io/p2p/12D3KooWKnDdG3iXw9eTFijk3EWSunZcFi54Zka4wmtqtt6rPxc8",
      "/ip4/104.131.131.82/tcp/4001/p2p/QmaCpDMGvV2BGHeYERUEnRQAwe3N8SzbUtfsmvsqQLuvuJ",
    ],
  })],
  services: {
    dht: kadDHT({
      clientMode: false,
      validators: { ipns: ipnsValidator },
      selectors: { ipns: ipnsSelector },
    }),
    identify: identify(),
    identifyPush: identifyPush(),
    keychain: keychain(),
    ping: ping(),
    fetch: fetch(),
  },
};
