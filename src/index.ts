/**
 * @packageDocumentation
 *
 * @example
 *
 * ```typescript
 * ```
 */

import type { Ed25519PeerId } from '@libp2p/interface/peer-id'
import type { QueryEvent } from '@libp2p/kad-dht'
import type { Blockstore } from 'interface-blockstore'
import type { CID } from 'multiformats/cid'

export { toDcid } from './dcid.js'

export interface Advertiser {
  collaborate: (dcid: CID, provider: Ed25519PeerId) => AsyncIterable<QueryEvent>
  findCollaborators: (dcid: CID) => AsyncIterable<QueryEvent>
}

export interface Namer {
  publish: (key: Ed25519PeerId, value: CID) => Promise<void>
  resolve: (key: Ed25519PeerId) => Promise<CID>
}

export interface Pinner extends Blockstore {}

export interface Zzzync {
  readonly namer: Namer
  readonly advertiser: Advertiser
  readonly pinner: Pinner
}

class DefaultZzzync implements Zzzync {
  constructor (
    readonly namer: Namer,
    readonly advertiser: Advertiser,
    readonly pinner: Pinner
  ) {}
}

export function zzzync (
  namer: Namer,
  advertiser: Advertiser,
  pinner: Pinner
): Zzzync {
  return new DefaultZzzync(namer, advertiser, pinner)
}
