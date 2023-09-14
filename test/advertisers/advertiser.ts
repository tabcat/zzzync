import type { Advertiser } from '../../src'
import type { Ed25519PeerId } from '@libp2p/interface/peer-id'
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
  for await (const peerId of findCollaborators(dcid)) {
    if (peerId.toString() === provider.toString()) {
      return
    }
  }

  throw new Error('did not find provider')
}

export const spec = {
  collaborate,
  findCollaborators
}
