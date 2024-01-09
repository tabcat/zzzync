import { createEd25519PeerId } from '@libp2p/peer-id-factory'
import { CID } from 'multiformats'
import { dhtAdvertiser } from '../../src/advertisers/dht.js'
import { createLibp2pNode } from '../utils/create-libp2p.js'
import { lanKadProtocol } from '../utils/protocols.js'
import { spec } from './advertiser.js'
import type { CreateEphemeralKadDHT } from '../../src/advertisers/dht.js'
import type { Advertiser } from '../../src/index.js'
import type { Ed25519PeerId, PeerId } from '@libp2p/interface/peer-id'
import type { KadDHT } from '@libp2p/kad-dht'
import type { Multiaddr } from '@multiformats/multiaddr'
import type { Libp2p } from 'libp2p'

type Libp2pWithDHT = Libp2p<{ dht: KadDHT }>

describe('advertisers/dht.ts', () => {
  let
    client: Libp2pWithDHT,
    server: Libp2pWithDHT,
    advertiser: Advertiser,
    dcid: CID,
    provider: Ed25519PeerId,
    addrs: Multiaddr[]

  const createEphemeralKadDHT: CreateEphemeralKadDHT = async (peerId: PeerId): ReturnType<CreateEphemeralKadDHT> => {
    const libp2p = await createLibp2pNode(peerId)

    await libp2p.dialProtocol(addrs, lanKadProtocol)

    return {
      dht: libp2p.services.dht,
      stop: async () => libp2p.stop()
    }
  }

  before(async () => {
    client = await createLibp2pNode()
    server = await createLibp2pNode()
    addrs = server.getMultiaddrs()
    await client.dialProtocol(addrs, lanKadProtocol)
    advertiser = dhtAdvertiser(client, createEphemeralKadDHT)
    provider = await createEd25519PeerId()
    dcid = CID.parse('bafyreihypffwyzhujryetatiy5imqq3p4mokuz36xmgp7wfegnhnjhwrsq')
  })

  after(async () => {
    await client.stop()
    await server.stop()
  })

  it('advertises non-self peerId as collaborator', async () => {
    await spec.collaborate({
      collaborate: advertiser.collaborate,
      server: server.peerId as Ed25519PeerId,
      provider,
      dcid
    })
  })

  it('finds non-self peerId as collaborator', async () => {
    await spec.findCollaborators({
      findCollaborators: advertiser.findCollaborators,
      server: server.peerId as Ed25519PeerId,
      provider,
      dcid
    })
  })
})
