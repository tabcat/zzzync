import { generateKeyPair, privateKeyToProtobuf } from "@libp2p/crypto/keys";
import { base36 } from "multiformats/bases/base36";
import { parseArgs } from "node:util";
import { SupportedPrivateKey } from "../challenge.js";
import { contenthash } from "../utils.js";
import { SubCommand } from "./index.js";

const contenthashMessage = (privateKey: SupportedPrivateKey) => `
${contenthash(privateKey.publicKey)}

This is the contenthash for the IPNS publishing key
Use it to set the contenthash field for an ENS domain
After content is uploaded, it can be resolved via ENS
`;

const publisherKeyMessage = (privateKey: SupportedPrivateKey) => `
ZZZYNC_PUBLISHER_KEY=${base36.encode(privateKeyToProtobuf(privateKey))}

This is the IPNS publishing key for the repo
Add this to .env file in repo root
Be sure to add .env to .gitignore
`;

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

  const privateKey = await generateKeyPair(values.type) as SupportedPrivateKey;

  console.log(publisherKeyMessage(privateKey));
  console.log(contenthashMessage(privateKey));
};
