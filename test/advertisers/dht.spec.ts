import { kadDHT } from '@libp2p/kad-dht'
import { createEd25519PeerId } from '@libp2p/peer-id-factory'
import { CID } from 'multiformats'
import * as dhtAdvertiser from '../../src/advertisers/dht.js'
import { lanKadProtocol } from '../../src/utils/constant.js'
import { createLibp2pNode } from '../../src/utils/libp2p.js'
import { specs } from './advertisers.spec.js'
import type { Advertiser } from '../../src/index.js'
import type { Ed25519PeerId } from '@libp2p/interface-peer-id'
import type { Controller } from 'ipfsd-ctl'
import type { Libp2p } from 'libp2p'

describe('advertisers/dht.ts', () => {
  let
    client: Libp2p,
    server: Libp2p,
    kubo: Controller,
    advertiser: Advertiser,
    dcid: CID,
    provider: Ed25519PeerId

  before(async () => {
    client = await createLibp2pNode({
      dht: kadDHT({ clientMode: true })
    })
    server = await createLibp2pNode({
      dht: kadDHT({ clientMode: false })
    })
    await client.dialProtocol(server.getMultiaddrs(), lanKadProtocol)
    advertiser = dhtAdvertiser.advertiser(client)
    provider = await createEd25519PeerId()
    dcid = CID.parse('bafyreihypffwyzhujryetatiy5imqq3p4mokuz36xmgp7wfegnhnjhwrsq')
  })

  after(async () => {
    await client.stop()
    await server.stop()
    if (kubo !== null) await kubo.stop()
  })

  it('advertises non-self peerId as collaborator', async () => {
    await specs.collaborate({
      collaborate: advertiser.collaborate,
      server: server.peerId as Ed25519PeerId,
      provider,
      dcid
    })
  })

  it('finds non-self peerId as collaborator', async () => {
    await specs.collaborate({
      collaborate: advertiser.findCollaborators,
      server: server.peerId as Ed25519PeerId,
      provider,
      dcid
    })
  })
})
