import { expect } from 'aegir/chai'
import type { Advertiser } from '../../src'
import type { PeerResponseEvent } from '@libp2p/interface-dht'
import type { Ed25519PeerId } from '@libp2p/interface-peer-id'
import type { CID } from 'multiformats/cid'

interface AdvertiserOptions {
  server: Ed25519PeerId
  provider: Ed25519PeerId
  dcid: CID
}

interface CollaborateOptions extends AdvertiserOptions {
  collaborate: Advertiser['collaborate']
}

async function collaborate ({ collaborate, server, dcid, provider }: CollaborateOptions): Promise<void> {
  let response: PeerResponseEvent | undefined
  for await (const event of collaborate(dcid, provider)) {
    if (event.name === 'PEER_RESPONSE' && event.messageName === 'ADD_PROVIDER') {
      if (event.from.equals(server)) {
        response = event
      }
    }
  }

  expect(response).to.not.equal(undefined)
}

interface FindCollaboratorsOptions extends AdvertiserOptions {
  findCollaborators: Advertiser['findCollaborators']
}

async function findCollaborators ({ findCollaborators, server, provider, dcid }: FindCollaboratorsOptions): Promise<void> {
  let response: PeerResponseEvent | undefined
  for await (const event of findCollaborators(dcid)) {
    if (event.name === 'PEER_RESPONSE' && event.messageName === 'GET_PROVIDERS') {
      if (event.from.equals(server)) {
        response = event
      }
    }
  }

  expect(response).to.not.equal(undefined)
  expect(response?.providers.length).to.equal(1)
  expect(response?.providers[0].id.equals(provider)).to.equal(true)
}

export const specs = {
  collaborate,
  findCollaborators
}
