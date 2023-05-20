import { CID } from 'multiformats/cid'
import * as raw from 'multiformats/codecs/raw'
import { sha256 } from 'multiformats/hashes/sha2'

export async function createCID (): Promise<CID> {
  return CID.create(1, raw.code, await sha256.digest(new TextEncoder().encode(Date.now().toString())))
}
