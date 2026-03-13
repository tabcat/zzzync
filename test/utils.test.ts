import type { Address, Peer } from "@libp2p/interface";
import { multiaddr } from "@multiformats/multiaddr";
import { stubInterface } from "sinon-ts";
import { describe, expect, it } from "vitest";
import { detectUpdate } from "../src/cli/utils.js";

function makeAddress(ma: string, isCertified = false): Address {
  return { multiaddr: multiaddr(ma), isCertified };
}

function makePeer(addresses: Address[]): Peer {
  return stubInterface<Peer>({ addresses });
}

describe("detectUpdate", () => {
  it("returns true when prev is undefined", () => {
    const peer = makePeer([makeAddress("/ip4/127.0.0.1/tcp/1234")]);
    expect(detectUpdate(peer)).toBe(true);
  });

  it("returns false when addresses are identical", () => {
    const addr = makeAddress("/ip4/127.0.0.1/tcp/1234");
    expect(detectUpdate(makePeer([addr]), makePeer([addr]))).toBe(false);
  });

  it("returns true when port changes", () => {
    const peer = makePeer([makeAddress("/ip4/127.0.0.1/tcp/1234")]);
    const prev = makePeer([makeAddress("/ip4/127.0.0.1/tcp/5678")]);
    expect(detectUpdate(peer, prev)).toBe(true);
  });

  it("returns true when an address is added", () => {
    const addr = makeAddress("/ip4/127.0.0.1/tcp/1234");
    const peer = makePeer([addr, makeAddress("/ip4/127.0.0.1/tcp/5678")]);
    const prev = makePeer([addr]);
    expect(detectUpdate(peer, prev)).toBe(true);
  });

  it("returns true when an address is removed", () => {
    const addr = makeAddress("/ip4/127.0.0.1/tcp/1234");
    const peer = makePeer([addr]);
    const prev = makePeer([addr, makeAddress("/ip4/127.0.0.1/tcp/5678")]);
    expect(detectUpdate(peer, prev)).toBe(true);
  });
});
