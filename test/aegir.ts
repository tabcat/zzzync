import { readFileSync } from 'fs'
import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { circuitRelayServer } from '@libp2p/circuit-relay-v2'
import { type Identify, identify } from '@libp2p/identify'
import { type KadDHT, kadDHT } from '@libp2p/kad-dht'
import { tcp } from '@libp2p/tcp'
import { webSockets } from '@libp2p/websockets'
import * as filters from '@libp2p/websockets/filters'
import getPort from 'aegir/get-port'
import { MemoryBlockstore } from 'blockstore-core'
import { MemoryDatastore } from 'datastore-core'
import { createHelia } from 'helia'
import { ipnsSelector } from 'ipns/selector'
import { ipnsValidator } from 'ipns/validator'
import { type Libp2pOptions, createLibp2p, type Libp2p } from 'libp2p'
// import w3nameServer from './mocks/w3name.js'
import type { Helia } from '@helia/interface'
import type { ServiceMap } from '@libp2p/interface'
import type { GlobalOptions, TestOptions } from 'aegir'

let WEB3_STORAGE_TOKEN: string | null = null

try {
  WEB3_STORAGE_TOKEN = readFileSync('.token', 'utf8').trim()
} catch {
  // eslint-disable-next-line no-console
  console.log('no web3.storage token provided, skipping pinner/w3 tests')
}

interface Services extends ServiceMap {
  identify: Identify
  dht: KadDHT
}

async function createLibp2pNode (): Promise<Libp2p<Services>> {
  const datastore = new MemoryDatastore()
  const options: Libp2pOptions<Services> = {
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
    services: {
      identify: identify(),
      dht: kadDHT({
        validators: { ipns: ipnsValidator },
        selectors: { ipns: ipnsSelector }
      }),
      relay: circuitRelayServer({ advertise: true })
    }
  }
  return createLibp2p(options)
}

export async function createHeliaNode (): Promise<Helia<Libp2p<Services>>> {
  const blockstore = new MemoryBlockstore()
  const datastore = new MemoryDatastore()

  const libp2p = await createLibp2pNode()

  const helia = await createHelia<Libp2p<Services>>({
    libp2p,
    blockstore,
    datastore
  })

  return helia
}

interface BeforeResult {
  env: typeof process.env
  helia?: Helia<Libp2p<Services>>
}

export default {
  test: {
    before: async (options: GlobalOptions & TestOptions): Promise<BeforeResult> => {
      const W3_NAME_PORT = await getPort()
      // w3nameServer.listen(W3_NAME_PORT)

      const result: BeforeResult = {
        env: {
          W3_NAME_PORT: W3_NAME_PORT.toString()
        }
      }

      if (WEB3_STORAGE_TOKEN != null) {
        // pinner tests are broken
        // result.env.WEB3_STORAGE_TOKEN = WEB3_STORAGE_TOKEN
      }

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

        result.env = {
          ...result.env,
          RELAY_MULTI_ADDR: helia.libp2p.getMultiaddrs()[0].toString()
        }
        result.helia = helia
      }

      return result
    },
    after: async (options: GlobalOptions & TestOptions, beforeResult: BeforeResult) => {
      if (options.runner !== 'node') {
        // await beforeResult.ipfsdServer.stop()
        await beforeResult.helia?.stop()
        // w3nameServer.close()
      }
    }
  }
}
