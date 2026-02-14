import { logger } from "@libp2p/logger";
import { existsSync, readFileSync, watchFile } from "node:fs";
import { join } from "node:path";
import { SupportedPrivateKey } from "../challenge.js";
import { ZZZYNC } from "../constants.js";
import { AllowFn } from "../handler.js";
import { contenthash } from "../utils.js";

const log = logger(`${ZZZYNC}:allow`);

export function createDefaultAllow(configDir: string): AllowFn {
  const allowPath = join(configDir, "allow");
  const allowed = new Set<string>();

  watchFile(allowPath, { interval: 500 }, (cur, prev) => {
    if (cur.mtimeMs === prev.mtimeMs) {
      return;
    }
    log("allow list updated");
    allowed.clear();

    if (!existsSync(allowPath)) return;

    const data = readFileSync(allowPath, "utf8");
    for (const line of data.split("\n")) {
      allowed.add(line);
    }
  });

  return (publicKey: SupportedPrivateKey["publicKey"]): boolean => {
    return allowed.has(contenthash(publicKey));
  };
}
