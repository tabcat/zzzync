import { watchlist } from "@tabcat/watchlist";
import { join } from "node:path";
import { SupportedPrivateKey } from "../challenge.js";
import { Allow } from "../handler.js";
import { contenthash } from "../utils.js";

export function createDefaultAllow(configDir: string): Allow {
  const { set, ready, stop } = watchlist(join(configDir, "allow"));

  return {
    allow: (publicKey: SupportedPrivateKey["publicKey"]): boolean => {
      return set.has(contenthash(publicKey));
    },
    start: () => ready,
    stop,
  };
}
