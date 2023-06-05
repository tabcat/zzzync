import getPort from 'aegir/get-port'
import { createHeliaNode } from './dist/test/utils/create-helia.js'

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