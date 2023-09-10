import { expect } from 'aegir/chai'
import type { Advertiser } from '../../src'
import type { Ed25519PeerId, PeerId } from '@libp2p/interface/peer-id'
import type { CID } from 'multiformats/cid'

interface AdvertiserOptions {
  server: Ed25519PeerId
  provider: Ed25519PeerId
  dcid: CID
}

interface CollaborateOptions extends AdvertiserOptions {
  collaborate: Advertiser['collaborate']
}

async function collaborate ({ collaborate, dcid, provider }: CollaborateOptions): Promise<void> {
  await collaborate(dcid, provider)
}

interface FindCollaboratorsOptions extends AdvertiserOptions {
  findCollaborators: Advertiser['findCollaborators']
}

async function findCollaborators ({ findCollaborators, provider, dcid }: FindCollaboratorsOptions): Promise<void> {
  const providers: PeerId[] = []
  for await (const peerId of findCollaborators(dcid)) {
    providers.push(peerId)
  }

  expect(providers[0].toString()).to.equal(provider.toString())
}

export const spec = {
  collaborate,
  findCollaborators
}
