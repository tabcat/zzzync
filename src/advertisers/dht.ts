import type { Advertiser } from '../index.js'
import type { Ed25519PeerId } from '@libp2p/interface-peer-id'
import type { QueryEvent, DualKadDHT } from '@libp2p/kad-dht'
import type { Libp2p } from 'libp2p'
import type { CID } from 'multiformats/cid'

export type Libp2pWithDHT = Libp2p<{ dht: DualKadDHT }>

export interface CreateEphemeralLibp2p { (peerId: Ed25519PeerId): Promise<Libp2pWithDHT> }

const collaborate = (createEphemeralLibp2p: CreateEphemeralLibp2p): Advertiser['collaborate'] =>
  async function * (dcid: CID, provider: Ed25519PeerId): AsyncIterable<QueryEvent> {
    const ephemeral = await createEphemeralLibp2p(provider)
    yield * ephemeral.services.dht.provide(dcid)
    void ephemeral.stop()
  }

const findCollaborators = (libp2p: Libp2pWithDHT): Advertiser['findCollaborators'] =>
  function (dcid: CID): AsyncIterable<QueryEvent> {
    return libp2p.services.dht.findProviders(dcid)
  }

export function advertiser (libp2p: Libp2pWithDHT, createEphemeralLibp2p: CreateEphemeralLibp2p): Advertiser {
  return {
    collaborate: collaborate(createEphemeralLibp2p),
    findCollaborators: findCollaborators(libp2p)
  }
}
