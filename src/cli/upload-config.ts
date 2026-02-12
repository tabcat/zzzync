import { fetch } from "@libp2p/fetch";
import { type DefaultLibp2pServices, type Helia, libp2pDefaults } from "helia";
import type { Libp2p, Libp2pOptions } from "libp2p";
import { ZzzyncServices } from "../server.js";

export interface UploadConfig<T extends ZzzyncServices> {
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

const libp2p = libp2pDefaults();
export const libp2pOptions: UploadConfig<
  DefaultLibp2pServices & ZzzyncServices
>["libp2pOptions"] = {
  ...libp2p,
  services: { ...libp2p.services, fetch: fetch() },
};
