import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { tcp } from '@libp2p/tcp'
import { type Libp2p, type Libp2pOptions, createLibp2p } from 'libp2p'

export async function createLibp2pNode (options: Libp2pOptions): Promise<Libp2p> {
  return createLibp2p({
    addresses: {
      listen: ['/ip4/0.0.0.0/tcp/0']
    },
    transports: [
      tcp()
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
