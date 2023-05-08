import { kadDHT } from '@libp2p/kad-dht'
import { MemoryDatastore } from 'datastore-core'
import all from 'it-all'
import { type Libp2p, type Libp2pOptions, createLibp2p } from 'libp2p'
import type { Advertiser } from '../index.js'
import type { QueryEvent, FinalPeerEvent } from '@libp2p/interface-dht'
import type { PeerId } from '@libp2p/interface-peer-id'
import type { CID } from 'multiformats/cid'

const collaborate = (libp2p: Libp2p) =>
  async function * (dcid: CID, provider: PeerId): AsyncIterable<QueryEvent> {
    // quick and dirty
    const finalPeers: FinalPeerEvent[] = (await all(libp2p.dht.getClosestPeers(dcid.multihash.bytes)))
      .filter((event): event is FinalPeerEvent => event.name === 'FINAL_PEER')
    const ephemeral: Libp2p = await createLibp2p(libp2pOptions(provider))
    await Promise.race(finalPeers.map(async (event: FinalPeerEvent) => ephemeral.dialProtocol(event.peer.multiaddrs, '/ipfs/kad/1.0.0')))
    yield * ephemeral.dht.provide(dcid)
  }

const findCollaborators = (libp2p: Libp2p) =>
  async function * (cid: CID): AsyncIterable<QueryEvent> {
    yield * libp2p.dht.findProviders(cid)
  }

export function advertiser (libp2p: Libp2p): Advertiser {
  return {
    collaborate: collaborate(libp2p),
    findCollaborators: findCollaborators(libp2p)
  }
}

const libp2pOptions = (peerId: PeerId): Libp2pOptions => {
  return {
    peerId,
    datastore: new MemoryDatastore(),
    dht: kadDHT({ clientMode: true })
  }
}
