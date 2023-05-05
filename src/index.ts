/**
 * @packageDocumentation
 *
 * @example
 *
 * ```typescript
 * ```
 */

import type { QueryEvent } from '@libp2p/kad-dht'
import type { IPNSEntry } from 'ipns'
import type { CID } from 'multiformats/cid'

export interface Namer {
  publish: (key: string, value: string) => Promise<IPNSEntry>
  resolve: (key: string) => Promise<IPNSEntry>
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
