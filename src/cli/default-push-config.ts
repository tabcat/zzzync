import { type DefaultLibp2pServices, type Helia, libp2pDefaults } from "helia";
import type { Libp2p, Libp2pOptions } from "libp2p";

export interface PushConfig {
  /**
   * A function to run before helia is started.
   *
   * @param helia
   * @returns
   */
  beforeStart?: (helia: Helia<Libp2p<DefaultLibp2pServices>>) => Promise<void>;

  /**
   * The libp2p options to use
   */
  libp2pOptions?: Libp2pOptions<DefaultLibp2pServices>;
}

export const libp2pOptions: PushConfig["libp2pOptions"] = libp2pDefaults();
