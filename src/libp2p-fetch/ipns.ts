import type { Fetch, LookupFunction } from "@libp2p/fetch";
import type { AbortOptions, PeerId } from "@libp2p/interface";
import { Record } from "@libp2p/kad-dht";
import { type Datastore, Key } from "interface-datastore";
import type { IPNSRecord } from "ipns";
import { multihashToIPNSRoutingKey, unmarshalIPNSRecord } from "ipns";
import { ipnsValidator } from "ipns/validator";
import { toString as uint8ArrayToString } from "uint8arrays";
import { IPNS_PREFIX } from "../constants.ts";
import type { IpnsMultihash } from "../interface.ts";

/**
 * Fetch one peer's IPNS record for `ipnsMultihash` over the libp2p fetch
 * protocol, then validate it against the routing key before returning it.
 * Answers "does that peer hold a record for this name", where the DHT answers
 * "does anyone".
 */
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

// @helia/ipns keeps published records in its local store under this prefix
const DHT_RECORD_PREFIX = "/dht/record/";
function dhtRoutingKey(key: Uint8Array): Key {
  return new Key(DHT_RECORD_PREFIX + uint8ArrayToString(key, "base32"), false);
}

export interface IpnsRecordLookupComponents {
  datastore: Datastore;
}

/**
 * A `LookupFunction` serving IPNS records straight out of the datastore
 * @helia/ipns publishes them to, so a peer can answer for names it holds
 * without a DHT round trip. Unknown names resolve to `undefined` rather than
 * throwing.
 */
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

/**
 * Register an IPNS record `LookupFunction` on the libp2p fetch service under
 * `IPNS_PREFIX`. Returns a function that unregisters it.
 *
 * Only register this if you are NOT using @helia/ipns's pubsub routing. That
 * router registers its own lookup under the same `/ipns/` prefix, and
 * @libp2p/fetch rejects a second registration for a prefix outright:
 *
 * ```
 * InvalidParametersError: Fetch protocol handler for key prefix '/ipns/' already registered
 * ```
 *
 * So this is for nodes serving IPNS over fetch without that router, not an
 * addition to it.
 */
export function registerFetchIpnsLookup(
  fetch: Pick<Fetch, "registerLookupFunction" | "unregisterLookupFunction">,
  lookup: LookupFunction,
): () => void {
  fetch.registerLookupFunction(IPNS_PREFIX, lookup);

  return () => {
    fetch.unregisterLookupFunction(IPNS_PREFIX, lookup);
  };
}
