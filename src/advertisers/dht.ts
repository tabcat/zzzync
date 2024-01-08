import drain from 'it-drain'
import type { Advertiser } from '../index.js'
import type { PeerId } from '@libp2p/interface/peer-id'
import type { KadDHT } from '@libp2p/kad-dht'
import type { Libp2p } from 'libp2p'
import type { CID } from 'multiformats/cid'

export interface CreateEphemeralKadDHT {
  (provider: PeerId): Promise<{ dht: KadDHT, stop?(): Promise<void> }>
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

const findCollaborators = (libp2p: Libp2p): Advertiser['findCollaborators'] =>
  async function * (dcid: CID): AsyncIterable<PeerId> {
    try {
      for await (const peerInfo of libp2p.contentRouting.findProviders(dcid)) {
        yield peerInfo.id
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(e)
    }
  }

export function dhtAdvertiser (libp2p: Libp2p, createEphemeralKadDHT: CreateEphemeralKadDHT): Advertiser {
  return {
    collaborate: collaborate(createEphemeralKadDHT),
    findCollaborators: findCollaborators(libp2p)
  }
}
