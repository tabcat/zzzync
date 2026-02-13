import type { Fetch, LookupFunction } from "@libp2p/fetch";
import type { AbortOptions, PeerId } from "@libp2p/interface";
import { Record } from "@libp2p/kad-dht";
import type { IPNSRecord } from "@tabcat/helia-ipns";
import { ipnsValidator } from "@tabcat/helia-ipns";
import { type Datastore, Key } from "interface-datastore";
import { multihashToIPNSRoutingKey, unmarshalIPNSRecord } from "ipns";
import { toString as uint8ArrayToString } from "uint8arrays";
import type { IpnsMultihash } from "../interface.js";

export async function fetchIpnsRecord(
  fetch: Fetch["fetch"],
  peerId: PeerId,
  ipnsMultihash: IpnsMultihash,
  options: AbortOptions = {},
): Promise<IPNSRecord | undefined> {
  const routingKey = multihashToIPNSRoutingKey(ipnsMultihash);
  const marshalledRecord = await fetch(peerId, routingKey, options);

  if (!marshalledRecord) {
    return undefined;
  }
  await ipnsValidator(routingKey, marshalledRecord);

  return unmarshalIPNSRecord(marshalledRecord);
}

// @helia/ipns localStore record key
const DHT_RECORD_PREFIX = "/dht/record/";
function dhtRoutingKey(key: Uint8Array): Key {
  return new Key(DHT_RECORD_PREFIX + uint8ArrayToString(key, "base32"), false);
}

export interface IpnsRecordLookupComponents {
  datastore: Datastore;
}

export const createIpnsRecordLookup =
  (components: IpnsRecordLookupComponents): LookupFunction =>
  async (routingKey) => {
    const { datastore } = components;
    try {
      const data = await datastore.get(dhtRoutingKey(routingKey));
      const record = Record.deserialize(data);

      return record.value;
    } catch (e) {
      if (e instanceof Error && e.name === "NotFoundError") {
        return undefined;
      }
      throw e;
    }
  };
