/**
 * @packageDocumentation
 *
 * @example
 *
 * ```typescript
 * ```
 */

import type { Ed25519PeerId } from '@libp2p/interface-peer-id'
import type { QueryEvent } from '@libp2p/kad-dht'
import type { CID } from 'multiformats/cid'

export { toDcid } from './dcid.js'

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

class DefaultZzzync implements Zzzync {
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
): Zzzync {
  return new DefaultZzzync(namer, advertiser)
}
