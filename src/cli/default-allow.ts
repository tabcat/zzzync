import { watchlist } from "@tabcat/watchlist";
import { join } from "node:path";
import { SupportedPrivateKey } from "../challenge.js";
import { AllowFn } from "../handler.js";
import { contenthash } from "../utils.js";

export function createDefaultAllow(configDir: string): AllowFn {
  const { set } = watchlist(join(configDir, "allow"));

  return (publicKey: SupportedPrivateKey["publicKey"]): boolean => {
    return set.has(contenthash(publicKey));
  };
}
