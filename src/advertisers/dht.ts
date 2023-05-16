import all from 'it-all'
import { type Libp2p, createLibp2p } from 'libp2p'
import { libp2pOptions } from './ephemeral-libp2p.js'
import type { Advertiser } from '../index.js'
import type { QueryEvent, FinalPeerEvent } from '@libp2p/interface-dht'
import type { Ed25519PeerId } from '@libp2p/interface-peer-id'
import type { CID } from 'multiformats/cid'

const collaborate = (libp2p: Libp2p): Advertiser['collaborate'] =>
  async function * (dcid: CID, provider: Ed25519PeerId): AsyncIterable<QueryEvent> {
    // quick and dirty
    const finalPeers: FinalPeerEvent[] = await all(
      libp2p.dht.getClosestPeers(dcid.multihash.bytes)
    ).then((res: QueryEvent[]) => res.filter((event): event is FinalPeerEvent => event.name === 'FINAL_PEER'))
    const ephemeral: Libp2p = await createLibp2p(libp2pOptions(provider))
    await Promise.all(finalPeers.map(async (event: FinalPeerEvent) => ephemeral.dialProtocol(event.peer.multiaddrs, '/ipfs/lan/kad/1.0.0')))
    yield * ephemeral.dht.provide(dcid)
    void ephemeral.stop()
  }

const findCollaborators = (libp2p: Libp2p): Advertiser['findCollaborators'] =>
  function (cid: CID): AsyncIterable<QueryEvent> {
    return libp2p.dht.findProviders(cid)
  }

export function advertiser (libp2p: Libp2p): Advertiser {
  return {
    collaborate: collaborate(libp2p),
    findCollaborators: findCollaborators(libp2p)
  }
}
