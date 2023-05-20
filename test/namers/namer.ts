import { expect } from 'aegir/chai'
import type { Namer } from '../../src'
import type { Ed25519PeerId } from '@libp2p/interface-peer-id'
import type { CID } from 'multiformats/cid'

interface NamerOptions {
  key: Ed25519PeerId
  value: CID
}

interface PublishOptions extends NamerOptions {
  publish: Namer['publish']
}

async function publish ({ publish, key, value }: PublishOptions): Promise<void> {
  await publish(key, value)
}

interface ResolveOptions extends NamerOptions {
  resolve: Namer['resolve']
}

async function resolve ({ resolve, key, value }: ResolveOptions): Promise<void> {
  const cid = await resolve(key)

  expect(cid.equals(value)).to.equal(true)
}

interface UpdateOptions extends PublishOptions, ResolveOptions {
  newValue: CID
}

async function update ({ publish, resolve, key, value, newValue }: UpdateOptions): Promise<void> {
  await spec.resolve({ resolve, key, value })
  await spec.publish({ publish, key, value: newValue })
  await spec.resolve({ resolve, key, value: newValue })
}

export const spec = {
  publish,
  resolve,
  update
}
