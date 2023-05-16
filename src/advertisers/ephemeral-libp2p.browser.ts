import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { kadDHT } from '@libp2p/kad-dht'
import { webRTCStar } from '@libp2p/webrtc-star'
import { MemoryDatastore } from 'datastore-core'
import type { Ed25519PeerId } from '@libp2p/interface-peer-id'
import type { Libp2pOptions } from 'libp2p'

export const libp2pOptions = (peerId: Ed25519PeerId): Libp2pOptions => {
  return {
    peerId,
    datastore: new MemoryDatastore(),
    addresses: {
      listen: [
        '/dns4/wrtc-star1.par.dwebops.pub/tcp/443/wss/p2p-webrtc-star/'
      ]
    },
    transports: [
      webRTCStar().transport
    ],
    connectionEncryption: [
      noise()
    ],
    streamMuxers: [
      yamux()
    ],
    dht: kadDHT({ clientMode: true })
  }
}
