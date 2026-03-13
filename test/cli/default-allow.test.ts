import { generateKeyPair } from "@libp2p/crypto/keys";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupportedPrivateKey } from "../../src/challenge.js";
import { createDefaultAllow } from "../../src/cli/default-allow.js";
import { contenthash } from "../../src/utils.js";

// ─── shared fixtures ──────────────────────────────────────────────────────────

let tmpDir: string;
let allowedHash: string;
let allowedKey: SupportedPrivateKey;
let deniedKey: SupportedPrivateKey;

beforeAll(async () => {
  allowedKey = (await generateKeyPair("Ed25519")) as SupportedPrivateKey;
  deniedKey = (await generateKeyPair("Ed25519")) as SupportedPrivateKey;
  allowedHash = contenthash(allowedKey.publicKey);

  const { mkdtemp } = await import("node:fs/promises");
  tmpDir = await mkdtemp(join(tmpdir(), "zzzync-test-"));
  await writeFile(join(tmpDir, "allow"), allowedHash + "\n");
});

afterAll(async () => {
  await rm(tmpDir, { recursive: true });
});

// ─── createDefaultAllow ───────────────────────────────────────────────────────

describe("createDefaultAllow", () => {
  it("allows a key whose contenthash is in the allow file", async () => {
    const allow = createDefaultAllow(tmpDir);
    await allow.start!();
    expect(allow.allow(allowedKey.publicKey)).toBe(true);
    await allow.stop!();
  });

  it("denies a key whose contenthash is not in the allow file", async () => {
    const allow = createDefaultAllow(tmpDir);
    await allow.start!();
    expect(allow.allow(deniedKey.publicKey)).toBe(false);
    await allow.stop!();
  });

  it("start() resolves when the file is ready", async () => {
    const allow = createDefaultAllow(tmpDir);
    await expect(allow.start!()).resolves.not.toThrow();
    await allow.stop!();
  });
});
