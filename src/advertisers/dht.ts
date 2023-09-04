import type { Advertiser } from '../index.js'
import type { Ed25519PeerId } from '@libp2p/interface/peer-id'
import type { QueryEvent, KadDHT } from '@libp2p/kad-dht'
import type { CID } from 'multiformats/cid'

export interface CreateEphemeralKadDHT {
  (provider: Ed25519PeerId): Promise<{ dht: KadDHT, stop?: () => Promise<void> }>
}

const collaborate = (createEphemeralKadDHT: CreateEphemeralKadDHT): Advertiser['collaborate'] =>
  async function * (dcid: CID, provider: Ed25519PeerId): AsyncIterable<QueryEvent> {
    const { dht, stop } = await createEphemeralKadDHT(provider)

    try {
      yield * dht.provide(dcid)
    } finally {
      if (stop != null) {
        await stop()
      }
    }
  }

const findCollaborators = (dht: KadDHT): Advertiser['findCollaborators'] =>
  function (dcid: CID): AsyncIterable<QueryEvent> {
    return dht.findProviders(dcid)
  }

export function dhtAdvertiser (dht: KadDHT, createEphemeralKadDHT: CreateEphemeralKadDHT): Advertiser {
  return {
    collaborate: collaborate(createEphemeralKadDHT),
    findCollaborators: findCollaborators(dht)
  }
}
