import { ipns, type IPNS } from '@helia/ipns'
import { dht } from '@helia/ipns/routing'
import type { Namer } from '../index.js'
import type { Helia } from '@helia/interface'
import type { PeerId } from '@libp2p/interface-peer-id'
import type { CID } from 'multiformats/cid'

const publish = (ipns: IPNS) => async (peerId: PeerId, value: CID) => ipns.publish(peerId, value)

const resolve = (ipns: IPNS) => async (peerId: PeerId) => ipns.resolve(peerId)

export function namer (helia: Helia): Namer {
  const ns = ipns(helia, [dht(helia)])

  return {
    publish: publish(ns),
    resolve: resolve(ns)
  }
}
