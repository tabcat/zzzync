import type { Fetch, LookupFunction } from "@libp2p/fetch";
import type { Libp2p, StreamHandler } from "@libp2p/interface";
import sinon from "sinon";
import { afterEach, describe, expect, it } from "vitest";
import { IPNS_PREFIX, ZZZYNC_PUSH_PROTOCOL_ID } from "../src/constants.js";
import { registerZzzyncHandler } from "../src/handler.js";
import { registerZzzyncIpnsLookup } from "../src/libp2p-fetch/ipns.js";

afterEach(() => sinon.restore());

describe("registerZzzyncHandler", () => {
  it("registers under the push protocol id and unregisters", async () => {
    const handle = sinon.stub().resolves();
    const unhandle = sinon.stub().resolves();
    const libp2p = { handle, unhandle } as unknown as Pick<
      Libp2p,
      "handle" | "unhandle"
    >;
    const handler = (() => {}) as unknown as StreamHandler;

    const unregister = await registerZzzyncHandler(libp2p, handler);
    expect(handle.calledOnceWith(ZZZYNC_PUSH_PROTOCOL_ID, handler)).toBe(true);

    await unregister();
    expect(unhandle.calledOnceWith(ZZZYNC_PUSH_PROTOCOL_ID)).toBe(true);
  });
});

describe("registerZzzyncIpnsLookup", () => {
  it("registers the lookup under the ipns prefix and unregisters", () => {
    const registerLookupFunction = sinon.stub();
    const unregisterLookupFunction = sinon.stub();
    const fetch = {
      registerLookupFunction,
      unregisterLookupFunction,
    } as unknown as Fetch;
    const lookup = (() => {}) as unknown as LookupFunction;

    const unregister = registerZzzyncIpnsLookup(fetch, lookup);
    expect(registerLookupFunction.calledOnceWith(IPNS_PREFIX, lookup)).toBe(
      true,
    );

    unregister();
    expect(unregisterLookupFunction.calledOnceWith(IPNS_PREFIX, lookup)).toBe(
      true,
    );
  });
});
