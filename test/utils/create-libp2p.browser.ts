import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { webSockets } from '@libp2p/websockets'
import { all } from '@libp2p/websockets/filters'
import { MemoryDatastore } from 'datastore-core'
import { createLibp2p, type Libp2p, type Libp2pOptions } from 'libp2p'
import services, { type Services } from './services.js'

export async function createLibp2pNode (options?: Libp2pOptions<any>): Promise<Libp2p<Services>> {
  const datastore = new MemoryDatastore()

  // dial-only in the browser until webrtc browser-to-browser arrives
  return createLibp2p({
    transports: [
      webSockets({
        filter: all
      })
    ],
    connectionEncryption: [
      noise()
    ],
    streamMuxers: [
      yamux()
    ],
    datastore,
    connectionGater: {
      // allow dialing loopback
      denyDialMultiaddr: () => false
    },
    ...options,
    services
  })
}
