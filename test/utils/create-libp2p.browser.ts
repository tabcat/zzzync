import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { webRTC, webRTCDirect } from '@libp2p/webrtc'
import { webSockets } from '@libp2p/websockets'
import * as filters from '@libp2p/websockets/filters'
import { multiaddr } from '@multiformats/multiaddr'
import { MemoryDatastore } from 'datastore-core'
import { createLibp2p, type Libp2p, type Libp2pOptions } from 'libp2p'
import { circuitRelayTransport } from 'libp2p/circuit-relay'
import services, { type Services } from './services.js'

export async function createLibp2pNode (options?: Libp2pOptions<any>): Promise<Libp2p<Services>> {
  const datastore = new MemoryDatastore()

  const libp2p = await createLibp2p({
    addresses: {
      listen: [
        '/webrtc'
      ]
    },
    transports: [
      webRTC(),
      webRTCDirect(),
      webSockets({ filter: filters.all }),
      circuitRelayTransport({
        discoverRelays: 1
      })
    ],
    connectionEncryption: [
      noise()
    ],
    connectionGater: {
      denyDialMultiaddr: () => {
        // by default we refuse to dial local addresses from the browser since they
        // are usually sent by remote peers broadcasting undialable multiaddrs but
        // here we are explicitly connecting to a local node so do not deny dialing
        // any discovered address
        return false
      }
    },
    streamMuxers: [
      yamux()
    ],
    datastore,
    ...options,
    services
  })

  await libp2p.dial(multiaddr(process.env.RELAY_MULTI_ADDR))
  await new Promise(resolve => setTimeout(resolve, 1000))

  return libp2p
}

// const node = await createLibp2p({
//   addresses: {
//     listen: [
//       '/webrtc'
//     ]
//   },
//   transports: [
//     webSockets({
//       filter: filters.all,
//     }),
//     webRTC(),
//     circuitRelayTransport({
//       discoverRelays: 1,
//     }),
//   ],
//   connectionEncryption: [noise()],
//   streamMuxers: [mplex()],
//   connectionGater: {
//     denyDialMultiaddr: () => {
//       // by default we refuse to dial local addresses from the browser since they
//       // are usually sent by remote peers broadcasting undialable multiaddrs but
//       // here we are explicitly connecting to a local node so do not deny dialing
//       // any discovered address
//       return false
//     }
//   },
