import { kadDHT } from '@libp2p/kad-dht'
import { createEd25519PeerId } from '@libp2p/peer-id-factory'
import { expect } from 'aegir/chai'
import { CID } from 'multiformats'
import * as dhtAdvertiser from '../src/advertisers/dht.js'
import { createKuboNode } from './utils/create-kubo.js'
import { createLibp2pNode } from './utils/create-libp2p.js'
import type { Advertiser } from '../src/index.js'
import type { PeerResponseEvent } from '@libp2p/interface-dht'
import type { Ed25519PeerId } from '@libp2p/interface-peer-id'
import type { Controller } from 'ipfsd-ctl'
import type { Libp2p } from 'libp2p'

const kadProtocol = '/ipfs/lan/kad/1.0.0'

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
    kubo = await createKuboNode()
    await client.dialProtocol(server.getMultiaddrs(), kadProtocol)
    await client.dialProtocol(kubo.peer.addresses, kadProtocol)
    advertiser = dhtAdvertiser.advertiser(client)
    dcid = CID.parse('bafyreihypffwyzhujryetatiy5imqq3p4mokuz36xmgp7wfegnhnjhwrsq')
    provider = await createEd25519PeerId()
  })

  after(async () => {
    await client.stop()
    await server.stop()
    await kubo.stop()
  })

  it('advertises and finds non-self peerId as collaborator', async () => {
    const responses: {
      server: PeerResponseEvent[]
      kubo: PeerResponseEvent[]
    } = {
      server: [],
      kubo: []
    }

    for await (const event of advertiser.collaborate(dcid, provider)) {
      if (event.name === 'PEER_RESPONSE' && event.messageName === 'ADD_PROVIDER') {
        if (event.from.equals(server.peerId)) {
          responses.server[0] = event
        }
        if (event.from.equals(kubo.peer.id)) {
          responses.kubo[0] = event
        }
      }
    }

    expect(responses.server[0]).to.not.equal(undefined)
    expect(responses.kubo[0]).to.not.equal(undefined)

    for await (const event of advertiser.findCollaborators(dcid)) {
      if (event.name === 'PEER_RESPONSE' && event.messageName === 'GET_PROVIDERS') {
        if (event.from.equals(server.peerId)) {
          responses.server[1] = event
        }
        if (event.from.equals(kubo.peer.id)) {
          responses.kubo[1] = event
        }
      }
    }

    expect(responses.server[1]).to.not.equal(undefined)
    expect(responses.kubo[1]).to.not.equal(undefined)
    expect(responses.server[1].providers.length).to.equal(1)
    expect(responses.kubo[1].providers.length).to.equal(1)
    expect(responses.server[1].providers[0].id.equals(provider)).to.equal(true)
    expect(responses.kubo[1].providers[0].id.equals(provider)).to.equal(true)
  })
})
