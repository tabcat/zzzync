import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { tcp } from '@libp2p/tcp'
import { MemoryDatastore } from 'datastore-core'
import { createLibp2p, type Libp2p, type Libp2pOptions } from 'libp2p'

export async function createLibp2pNode (config: Libp2pOptions): Promise<Libp2p> {
  const datastore = new MemoryDatastore()
  return createLibp2p({
    addresses: {
      listen: [
        '/ip4/127.0.0.1/tcp/0'
      ]
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
    datastore,
    ...config
  })
}
