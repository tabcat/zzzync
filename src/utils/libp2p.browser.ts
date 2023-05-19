import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { webRTCStar } from '@libp2p/webrtc-star'
import { webSockets } from '@libp2p/websockets'
import { all } from '@libp2p/websockets/filters'
import { type Libp2p, type Libp2pOptions, createLibp2p } from 'libp2p'

export async function createLibp2pNode (options: Libp2pOptions): Promise<Libp2p> {
  return createLibp2p({
    addresses: {
      listen: [
        '/dns4/wrtc-star1.par.dwebops.pub/tcp/443/wss/p2p-webrtc-star'
      ]
    },
    transports: [
      webSockets({
        filter: all
      }),
      webRTCStar().transport
    ],
    connectionEncryption: [
      noise()
    ],
    streamMuxers: [
      yamux()
    ],
    ...options
  })
}
