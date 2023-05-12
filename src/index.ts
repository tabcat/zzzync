/**
 * @packageDocumentation
 *
 * @example
 *
 * ```typescript
 * ```
 */

import type { QueryEvent } from '@libp2p/interface-dht'
import type { Ed25519PeerId } from '@libp2p/interface-peer-id'
import type { CID } from 'multiformats/cid'

export interface Namer {
  publish: (key: Ed25519PeerId, value: CID) => Promise<void>
  resolve: (key: Ed25519PeerId) => Promise<CID>
}

export interface Advertiser {
  collaborate: (dcid: CID, provider: Ed25519PeerId) => AsyncIterable<QueryEvent>
  findCollaborators: (dcid: CID) => AsyncIterable<QueryEvent>
}

export interface Zzzync {
  namer: Namer
  advertiser: Advertiser
}

class DefaultZzzync implements DefaultZzzync {
  readonly namer: Namer
  readonly advertiser: Advertiser

  constructor (
    namer: Namer,
    advertiser: Advertiser
  ) {
    this.namer = namer
    this.advertiser = advertiser
  }
}

export function zzzync (
  namer: Namer,
  advertiser: Advertiser
): DefaultZzzync {
  return new DefaultZzzync(namer, advertiser)
}
