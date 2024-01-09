import { ipns, type IPNS } from '@helia/ipns'
import { libp2p } from '@helia/ipns/routing'
import type { Namer } from '../index.js'
import type { Helia } from '@helia/interface'
import type { Ed25519PeerId } from '@libp2p/interface/peer-id'
import type { CID } from 'multiformats/cid'

const publish = (ipns: IPNS): Namer['publish'] =>
  async (peerId: Ed25519PeerId, value: CID) => { void ipns.publish(peerId, value) }

const resolve = (ipns: IPNS): Namer['resolve'] =>
  async (peerId: Ed25519PeerId) => ipns.resolve(peerId)

export function ipnsNamer (helia: Helia): Namer {
  const ns = ipns(helia, { routers: [libp2p(helia)] })

  return {
    publish: publish(ns),
    resolve: resolve(ns)
  }
}
