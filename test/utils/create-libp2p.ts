import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { tcp } from '@libp2p/tcp'
import { MemoryDatastore } from 'datastore-core'
import { createLibp2p, type Libp2p, type Libp2pOptions } from 'libp2p'
import services, { type Services } from './services.js'

export async function createLibp2pNode (options?: Libp2pOptions<any>): Promise<Libp2p<Services>> {
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
    ...options,
    services
  })
}
