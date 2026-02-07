import { generateKeyPair, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { base36 } from "multiformats/bases/base36";
import { parseArgs } from "node:util";
import { SubCommand } from "./index.js";

export const run: SubCommand["run"] = async (args: string[]) => {
  const { values } = parseArgs({
    args,
    options: { type: { type: "string", default: "Ed25519" } },
    strict: true,
  });

  if (values.type !== "Ed25519" && values.type !== "secp256k1") {
    throw new Error(
      "unsupported key type. Use 'Ed25519' (default) or 'secp256k1' ",
    );
  }

  const privateKey = await generateKeyPair(values.type);

  console.log(
    `CONTENT_HASH=/ipns/${privateKey.publicKey.toCID().toString(base36)}`,
  );
  console.log(
    `PUBLISHER_KEY=${base36.encode(privateKeyToProtobuf(privateKey))}`,
  );
};
