import type { Advertiser } from '../index.js'
import type { Ed25519PeerId } from '@libp2p/interface-peer-id'
import type { QueryEvent, DualKadDHT, SingleKadDHT } from '@libp2p/kad-dht'
import type { Libp2p } from 'libp2p'
import type { CID } from 'multiformats/cid'

export type Libp2pWithDHT = Libp2p<{ dht: DualKadDHT }>

export interface CreateEphemeralLibp2p { (peerId: Ed25519PeerId): Promise<Libp2pWithDHT> }

const scopedDht = ({ services: { dht } }: Libp2pWithDHT, scope?: Scope): DualKadDHT | SingleKadDHT =>
  scope != null && scope in dht ? dht[scope] : dht

const collaborate = (createEphemeralLibp2p: CreateEphemeralLibp2p, options: Options): Advertiser['collaborate'] =>
  async function * (dcid: CID, provider: Ed25519PeerId): AsyncIterable<QueryEvent> {
    const ephemeral = await createEphemeralLibp2p(provider)
    yield * scopedDht(ephemeral, options.scope).provide(dcid)
    void ephemeral.stop()
  }

const findCollaborators = (libp2p: Libp2pWithDHT, options: Options): Advertiser['findCollaborators'] =>
  function (dcid: CID): AsyncIterable<QueryEvent> {
    return scopedDht(libp2p, options.scope).findProviders(dcid)
  }

type Scope = 'wan' | 'lan'

interface Options {
  scope?: Scope
}

export function dht (libp2p: Libp2pWithDHT, createEphemeralLibp2p: CreateEphemeralLibp2p, options: Options): Advertiser {
  return {
    collaborate: collaborate(createEphemeralLibp2p, options),
    findCollaborators: findCollaborators(libp2p, options)
  }
}
