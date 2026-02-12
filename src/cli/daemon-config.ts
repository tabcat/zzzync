import { fetch } from "@libp2p/fetch";
import { type DefaultLibp2pServices, type Helia, libp2pDefaults } from "helia";
import type { Libp2p, Libp2pOptions } from "libp2p";
import type { RegisterHandlersOptions, ZzzyncServices } from "../server.js";

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

const defaultLibp2p = libp2pDefaults();
export const libp2pOptions: DaemonConfig<
  DefaultLibp2pServices & ZzzyncServices
>["libp2pOptions"] = {
  ...defaultLibp2p,
  services: { ...defaultLibp2p.services, fetch: fetch() },
};
