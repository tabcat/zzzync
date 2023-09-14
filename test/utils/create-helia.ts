import { MemoryBlockstore } from 'blockstore-core'
import { MemoryDatastore } from 'datastore-core'
import { createHelia } from 'helia'
import { createLibp2pNode, type WithRelay } from './create-libp2p.js'
import type { Helia } from '@helia/interface'
import type { Libp2p } from 'libp2p'

export async function createHeliaNode (): Promise<Helia<Libp2p<WithRelay>>> {
  const blockstore = new MemoryBlockstore()
  const datastore = new MemoryDatastore()

  const libp2p = await createLibp2pNode()

  const helia = await createHelia({
    libp2p,
    blockstore,
    datastore
  })

  return helia
}
