import { createEd25519PeerId } from '@libp2p/peer-id-factory'
import { CID } from 'multiformats'
import * as dhtAdvertiser from '../../src/advertisers/dht.js'
import { createLibp2pNode } from '../utils/create-libp2p.js'
import { lanKadProtocol } from '../utils/protocols.js'
import { spec } from './advertiser.js'
import type { CreateEphemeralLibp2p, Libp2pWithDHT } from '../../src/advertisers/dht.js'
import type { Advertiser } from '../../src/index.js'
import type { Ed25519PeerId } from '@libp2p/interface-peer-id'
import type { Multiaddr } from '@multiformats/multiaddr'

describe('advertisers/dht.ts', () => {
  let
    client: Libp2pWithDHT,
    server: Libp2pWithDHT,
    advertiser: Advertiser,
    dcid: CID,
    provider: Ed25519PeerId,
    addrs: Multiaddr[]

  const createEphemeralLibp2p: CreateEphemeralLibp2p = async (peerId: Ed25519PeerId): Promise<Libp2pWithDHT> => {
    const libp2p = await createLibp2pNode({
      peerId
    })

    await libp2p.dialProtocol(addrs, lanKadProtocol)

    return libp2p
  }

  before(async () => {
    client = await createLibp2pNode()
    server = await createLibp2pNode()
    addrs = server.getMultiaddrs()
    await client.dialProtocol(addrs, lanKadProtocol)
    advertiser = dhtAdvertiser.dht(client, createEphemeralLibp2p)
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
