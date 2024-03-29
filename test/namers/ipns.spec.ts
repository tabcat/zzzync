// import { kadDHT } from '@libp2p/kad-dht'
import { createEd25519PeerId } from '@libp2p/peer-id-factory'
import { createHelia } from 'helia'
import * as ipnsNamer from '../../src/namers/ipns.js'
import { createCID } from '../utils/create-cid.js'
import { type WithRelay, createLibp2pNode } from '../utils/create-libp2p.js'
import { lanKadProtocol } from '../utils/protocols.js'
import { spec } from './namer.js'
import type { Namer } from '../../src/index.js'
import type { Helia } from '@helia/interface'
import type { Ed25519PeerId } from '@libp2p/interface/peer-id'
import type { Libp2p } from 'libp2p'
import type { CID } from 'multiformats/cid'

describe.skip('namers/ipns.ts', () => {
  let
    client: Helia<Libp2p<WithRelay>>,
    server: Helia<Libp2p<WithRelay>>,
    namer: Namer,
    key: Ed25519PeerId,
    value: CID,
    newValue: CID

  before(async () => {
    client = await createHelia({
      libp2p: await createLibp2pNode()
    })
    server = await createHelia({
      libp2p: await createLibp2pNode()
    })
    await client.libp2p.dialProtocol(server.libp2p.getMultiaddrs(), lanKadProtocol)
    namer = ipnsNamer.ipnsNamer(client)
    key = await createEd25519PeerId()
    value = await createCID()
    newValue = await createCID()
  })

  after(async () => {
    await client.stop()
    await server.stop()
  })

  it('publishes name/value pair', async () => {
    await spec.publish({
      publish: namer.publish,
      key,
      value
    })
  })

  it('resolves name/value pair', async () => {
    await spec.resolve({
      resolve: namer.resolve,
      key,
      value
    })
  })

  it('updates name/value pair', async () => {
    await spec.update({
      publish: namer.publish,
      resolve: namer.resolve,
      key,
      value,
      newValue
    })
  })
})
