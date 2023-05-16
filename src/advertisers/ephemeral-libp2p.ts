import { noise } from '@chainsafe/libp2p-noise'
import { yamux } from '@chainsafe/libp2p-yamux'
import { kadDHT } from '@libp2p/kad-dht'
import { tcp } from '@libp2p/tcp'
import { MemoryDatastore } from 'datastore-core'
import type { Ed25519PeerId } from '@libp2p/interface-peer-id'
import type { Libp2pOptions } from 'libp2p'

export const libp2pOptions = (peerId: Ed25519PeerId): Libp2pOptions => {
  return {
    peerId,
    datastore: new MemoryDatastore(),
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
    dht: kadDHT({ clientMode: true })
  }
}
