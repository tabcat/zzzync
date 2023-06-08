import { CID } from 'multiformats'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'
import { concat } from 'uint8arrays/concat'
import { fromString } from 'uint8arrays/from-string'

// dynamic content on ipfs
const DCOI_KEY = fromString('/dcoi/')

// similar to ipns routing key in js-ipns
const routingKey = (cid: CID): Uint8Array => concat([DCOI_KEY, cid.multihash.bytes])

// Use CID as Routing Key to make APIs easier to work with
export function toDcid (cid: CID): CID {
  const digest = sha256.digest(routingKey(cid))

  if (digest instanceof Promise) {
    throw new Error('unexpected asynchronous digest')
  }

  const dcid = CID.create(1, raw.code, digest)

  return dcid
}
