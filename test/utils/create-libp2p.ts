import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import * as filters from '@libp2p/websockets/filters'
import { MemoryDatastore } from 'datastore-core'
import { createLibp2p, type Libp2p, type Libp2pOptions } from 'libp2p'
import { circuitRelayServer, type CircuitRelayService } from 'libp2p/circuit-relay'
import services, { type Services } from './services.js'

interface WithRelay extends Services {
  relay: CircuitRelayService
}

export async function createLibp2pNode (options?: Libp2pOptions<any>): Promise<Libp2p<WithRelay>> {
  const datastore = new MemoryDatastore()
  return createLibp2p({
    addresses: {
      listen: [
        '/ip4/127.0.0.1/tcp/0/ws'
      ]
    },
    transports: [
      tcp(),
      webSockets({
        filter: filters.all
      })
    ],
    connectionEncryption: [
      noise()
    ],
    streamMuxers: [
      yamux()
    ],
    datastore,
    ...options,
    services: {
      ...services,
      relay: circuitRelayServer({ advertise: true })
    }
  })
}
