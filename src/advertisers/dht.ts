import { kadDHT } from '@libp2p/kad-dht'
import { multiaddr } from '@multiformats/multiaddr'
import all from 'it-all'
import { kadProtocol } from '../utils/constant.js'
import { createLibp2pNode } from '../utils/libp2p.js'
import type { Advertiser } from '../index.js'
import type { QueryEvent, FinalPeerEvent } from '@libp2p/interface-dht'
import type { Ed25519PeerId } from '@libp2p/interface-peer-id'
import type { Libp2p } from 'libp2p'
import type { CID } from 'multiformats/cid'

const collaborate = (libp2p: Libp2p): Advertiser['collaborate'] =>
  async function * (dcid: CID, provider: Ed25519PeerId): AsyncIterable<QueryEvent> {
    // quick and dirty
    const finalPeers: FinalPeerEvent[] = await all(
      libp2p.dht.getClosestPeers(dcid.multihash.bytes)
    ).then((res: QueryEvent[]) => res.filter((event): event is FinalPeerEvent => event.name === 'FINAL_PEER'))

    const ephemeral: Libp2p = await createLibp2pNode({
      peerId: provider,
      dht: kadDHT({ clientMode: true })
    })
    await Promise.all(
      finalPeers.map(
        async (event: FinalPeerEvent) => ephemeral.dialProtocol(
          event.peer.multiaddrs.map(m => multiaddr(m.toString() + '/p2p/' + event.peer.id.toString())),
          kadProtocol
        )
      )
    )
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
