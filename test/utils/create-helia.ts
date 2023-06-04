import { MemoryBlockstore } from 'blockstore-core'
import { MemoryDatastore } from 'datastore-core'
import { createHelia, type HeliaInit } from 'helia'
import { createLibp2pNode } from './create-libp2p.js'
import type { Helia } from '@helia/interface'

export async function createHeliaNode (init?: Partial<HeliaInit>): Promise<Helia> {
  const blockstore = new MemoryBlockstore()
  const datastore = new MemoryDatastore()

  const libp2p = await createLibp2pNode()

  const helia = await createHelia({
    libp2p,
    blockstore,
    datastore,
    ...init
  })

  return helia
}
