import drain from 'it-all'
import type { Advertiser } from '../index.js'
import type { PeerId } from '@libp2p/interface/peer-id'
import type { KadDHT } from '@libp2p/kad-dht'
import type { CID } from 'multiformats/cid'

export interface CreateEphemeralKadDHT {
  (provider: PeerId): Promise<{ dht: KadDHT, stop?: () => Promise<void> }>
}

const collaborate = (createEphemeralKadDHT: CreateEphemeralKadDHT): Advertiser['collaborate'] =>
  async function (dcid: CID, provider: PeerId): Promise<void> {
    const { dht, stop } = await createEphemeralKadDHT(provider)

    try {
      await drain(dht.provide(dcid))
    } finally {
      if (stop != null) {
        await stop()
      }
    }
  }

const findCollaborators = (dht: KadDHT): Advertiser['findCollaborators'] =>
  async function * (dcid: CID): AsyncIterable<PeerId> {
    for await (const event of dht.findProviders(dcid)) {
      if (event.name === 'PROVIDER' || event.name === 'PEER_RESPONSE') {
        for (const { id: peerId } of event.providers) {
          yield peerId
        }
      }
    }
  }

export function dhtAdvertiser (dht: KadDHT, createEphemeralKadDHT: CreateEphemeralKadDHT): Advertiser {
  return {
    collaborate: collaborate(createEphemeralKadDHT),
    findCollaborators: findCollaborators(dht)
  }
}
