import { car, type CarComponents } from "@helia/car";
import type { Helia, Pins, Routing } from "@helia/interface";
import type { Fetch } from "@libp2p/fetch";
import type {
  ComponentLogger,
  Libp2p,
  ServiceMap,
  StreamHandlerOptions,
} from "@libp2p/interface";
import type { Keychain } from "@libp2p/keychain";
import { ipns, type IPNSComponents } from "@tabcat/helia-ipns";
import { createHelia, type HeliaInit } from "helia";
import type { Blockstore } from "interface-blockstore";
import type { Datastore } from "interface-datastore";
import { IPNS_PREFIX, ZZZYNC_PROTOCOL_ID } from "./constants.js";
import { type CreateHandlerOptions, createZzzyncHandler } from "./handler.js";
import {
  createIpnsRecordLookup,
  type IpnsRecordLookupComponents,
} from "./libp2p-fetch/ipns.js";

export interface ZzzyncServices extends ServiceMap {
  fetch: Fetch;
  keychain: Keychain;
}

export interface ZzzyncServerComponents
  extends CarComponents, IPNSComponents, IpnsRecordLookupComponents
{
  datastore: Datastore;
  blockstore: Blockstore;
  routing: Routing;
  logger: ComponentLogger;
  libp2p: Libp2p<ZzzyncServices>;
  pins: Pins;
}

export interface RegisterHandlersOptions
  extends CreateHandlerOptions, StreamHandlerOptions
{}

export const registerHandlers = (
  components: ZzzyncServerComponents,
  options: RegisterHandlersOptions = {},
): { unregisterHandlers: () => void; } => {
  const ipnsRecordLookup = createIpnsRecordLookup(components);

  components.libp2p.services.fetch.registerLookupFunction(
    IPNS_PREFIX,
    ipnsRecordLookup,
  );
  components.libp2p.handle(
    ZZZYNC_PROTOCOL_ID,
    createZzzyncHandler(
      components.libp2p.peerId,
      ipns(components),
      car(components),
      components.pins,
      options,
    ),
    options,
  );

  const unregisterHandlers = (): void => {
    components.libp2p.services.fetch.unregisterLookupFunction(
      IPNS_PREFIX,
      ipnsRecordLookup,
    );
    components.libp2p.unhandle(ZZZYNC_PROTOCOL_ID);
  };

  return { unregisterHandlers };
};

export async function createZzzyncServer<T extends Libp2p<ZzzyncServices>>(
  init: Partial<HeliaInit<T>>,
  options: RegisterHandlersOptions = {},
): Promise<Helia<T>> {
  const helia = await createHelia(init);

  registerHandlers(helia, options);

  return helia;
}
