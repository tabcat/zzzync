/**
 * @packageDocumentation
 *
 * @example
 *
 * ```typescript
 * ```
 */

import type { PeerId } from '@libp2p/interface-peer-id'
import type { QueryEvent } from '@libp2p/kad-dht'
import type { IPNSEntry } from 'ipns'
import type { CID } from 'multiformats/cid'

export interface Namer {
  publish: (key: PeerId, value: CID) => Promise<IPNSEntry>
  resolve: (key: PeerId) => Promise<CID>
}

export interface Advertiser {
  collaborate: (cid: CID) => AsyncIterable<QueryEvent>
  findCollaborators: (cid: CID) => AsyncIterable<QueryEvent>
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
