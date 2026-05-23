import { generateKeyPair } from "@libp2p/crypto/keys";
import type { Fetch } from "@libp2p/fetch";
import type { Libp2p, PeerId } from "@libp2p/interface";
import { defaultLogger } from "@libp2p/logger";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import sinon from "sinon";
import { stubInterface } from "sinon-ts";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { IPNS_PREFIX, ZZZYNC_PUSH_PROTOCOL_ID } from "../src/constants.js";
import type { Allow } from "../src/handler.js";
import { registerHandlers } from "../src/server.js";
import type { ZzzyncServerComponents, ZzzyncServices } from "../src/server.js";

// ─── shared fixtures ──────────────────────────────────────────────────────────

let peerId: PeerId;

beforeAll(async () => {
  peerId = peerIdFromPrivateKey(await generateKeyPair("Ed25519"));
});

afterEach(() => sinon.restore());

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeComponents(): ZzzyncServerComponents {
  const fetchService = stubInterface<Fetch>();
  fetchService.registerLookupFunction = sinon.stub() as any;
  fetchService.unregisterLookupFunction = sinon.stub() as any;

  const libp2p = stubInterface<Libp2p<ZzzyncServices>>();
  (libp2p as any).peerId = peerId;
  (libp2p as any).services = { fetch: fetchService };
  libp2p.handle = sinon.stub() as any;
  libp2p.unhandle = sinon.stub() as any;

  const components = stubInterface<ZzzyncServerComponents>();
  (components as any).libp2p = libp2p;
  (components as any).logger = defaultLogger();
  (components as any).events = new EventTarget();

  return components;
}

function makeAllow(): Allow & {
  start: sinon.SinonStub;
  stop: sinon.SinonStub;
} {
  return {
    allow: sinon.stub().resolves(true),
    start: sinon.stub().resolves(),
    stop: sinon.stub().resolves(),
  };
}

const kubo = {
  block: { put: sinon.stub().resolves() },
  pin: { add: sinon.stub().resolves(), rm: sinon.stub().resolves() },
} as any;

// ─── registerHandlers ─────────────────────────────────────────────────────────

describe("registerHandlers", () => {
  it("calls allow.start() during registration", async () => {
    const allow = makeAllow();
    const components = makeComponents();

    await registerHandlers(components, kubo, { allow });

    expect(allow.start.calledOnce).toBe(true);
  });

  it("registers the fetch lookup function and the protocol handler", async () => {
    const components = makeComponents();
    await registerHandlers(components, kubo);

    const fetchService = (components.libp2p as any).services.fetch;
    expect(
      (fetchService.registerLookupFunction as sinon.SinonStub).calledOnceWith(
        IPNS_PREFIX,
        sinon
          .match
          .func,
      ),
    )
      .toBe(true);
    expect(
      (components.libp2p.handle as sinon.SinonStub).calledOnceWith(
        ZZZYNC_PUSH_PROTOCOL_ID,
        sinon
          .match
          .func,
      ),
    )
      .toBe(true);
  });

  it("calls allow.stop() and unregisters handlers when unregisterHandlers is called", async () => {
    const allow = makeAllow();
    const components = makeComponents();

    const { unregisterHandlers } = await registerHandlers(components, kubo, {
      allow,
    });
    await unregisterHandlers();

    expect(allow.stop.calledOnce).toBe(true);
    expect(
      (components.libp2p.unhandle as sinon.SinonStub).calledOnceWith(
        ZZZYNC_PUSH_PROTOCOL_ID,
      ),
    )
      .toBe(true);
    const fetchService = (components.libp2p as any).services.fetch;
    expect(
      (fetchService.unregisterLookupFunction as sinon.SinonStub).calledOnce,
    )
      .toBe(true);
  });

  it("works without an allow option", async () => {
    const components = makeComponents();
    const { unregisterHandlers } = await registerHandlers(components, kubo);
    await expect(unregisterHandlers()).resolves.not.toThrow();
  });
});
