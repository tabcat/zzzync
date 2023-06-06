import getPort from 'aegir/get-port'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import * as filters from '@libp2p/websockets/filters'
import { MemoryDatastore } from 'datastore-core'
import { createLibp2p, } from 'libp2p'
import { circuitRelayServer, } from 'libp2p/circuit-relay'
import { kadDHT } from '@libp2p/kad-dht'
import { ipnsSelector } from 'ipns/selector'
import { ipnsValidator } from 'ipns/validator'
import { identifyService } from 'libp2p/identify'
import { MemoryBlockstore } from 'blockstore-core'
import { createHelia } from 'helia'

const services = {
  identify: identifyService(),
  dht: kadDHT({
    validators: { ipns: ipnsValidator },
    selectors: { ipns: ipnsSelector }
  })
}

async function createLibp2pNode (options) {
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

export async function createHeliaNode (init) {
  const blockstore = new MemoryBlockstore()
  const datastore = new MemoryDatastore()

  const libp2p = await createLibp2pNode()

  const helia = await createHelia({
    libp2p,
    blockstore,
    datastore,
    ...init
  })

  return helia
}

/** @type {import('aegir').PartialOptions} */
export default {
  test: {
    before: async (options) => {
      if (options.runner !== 'node') {
        const helia = await createHeliaNode()

        // const ipfsdPort = await getPort()
        // const ipfsdServer = await createServer({
        //   host: '127.0.0.1',
        //   port: ipfsdPort
        // }, {
        //   ipfsBin: (await import('go-ipfs')).default.path(),
        //   kuboRpcModule: kuboRpcClient,
        //   ipfsOptions: {
        //     config: {
        //       Addresses: {
        //         Swarm: [
        //           "/ip4/0.0.0.0/tcp/0",
        //           "/ip4/0.0.0.0/tcp/0/ws"
        //         ]
        //       }
        //     }
        //   }
        // }).start()

        return {
          env: {
            RELAY_MULTI_ADDR: helia.libp2p.getMultiaddrs()[0].toString()
          },
          helia
        }
      }

      return {}
    },
    after: async (options, beforeResult) => {
      if (options.runner !== 'node') {
        // await beforeResult.ipfsdServer.stop()
        await beforeResult.helia.stop()
      }
    }
  }
}