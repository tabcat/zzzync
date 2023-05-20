import { createEd25519PeerId } from '@libp2p/peer-id-factory'
import { MemoryDatastore } from 'datastore-core'
import W3NameService from 'w3name/service'
import * as w3Namer from '../../src/namers/w3.js'
import { createCID } from '../utils/create-cid.js'
// import { createRateLimiter } from '../utils/create-rate-limitter.js'
import { spec } from './namer.js'
import type { Namer } from '../../src/index.js'
import type { Ed25519PeerId } from '@libp2p/interface-peer-id'
import type { CID } from 'multiformats/cid'

describe('namers/w3.ts', () => {
  let
    namer: Namer,
    key: Ed25519PeerId,
    value: CID,
    newValue: CID

  before(async () => {
    // if (process?.env?.W3NS == null) {
    //   throw new Error('W3NS env variable missing')
    // }
    // const service: W3NameService = {
    //   endpoint: new URL(process.env.W3NS),
    //   waitForRateLimit: createRateLimiter()
    // }

    const datastore = new MemoryDatastore()
    const revisions = w3Namer.revisionState(datastore)

    namer = w3Namer.namer(new W3NameService(), revisions)
    key = await createEd25519PeerId()
    value = await createCID()
    newValue = await createCID()
  })

  after(async () => {
  })

  it('advertises non-self peerId as collaborator', async () => {
    await spec.publish({
      publish: namer.publish,
      key,
      value
    })
  })

  it('finds non-self peerId as collaborator', async () => {
    await spec.resolve({
      resolve: namer.resolve,
      key,
      value
    })
  })

  it('updates the value for a name', async () => {
    await spec.update({
      publish: namer.publish,
      resolve: namer.resolve,
      key,
      value,
      newValue
    })
  })
})
