
import { Zzzync } from './zzzync.js'
import { Entry } from './entry.js'
import { Identity, getIdentity } from './identity.js'
import * as Name from 'web3.storage/name'

import * as Block from 'multiformats/block'
import * as codec from '@ipld/dag-cbor'
import { sha256 as hasher } from 'multiformats/hashes/sha2'

import { base32 } from 'multiformats/bases/base32'

const token = process.env.API_TOKEN
const key = process.env.NAME_KEY || base32.encode((await Name.create()).key.bytes)
const name = await Name.from(base32.decode(key))

const local = { token, key: await Name.from(base32.decode(key)) }

const zync1 = new Zzzync({ local }) // wont be polling for any names
await zync1.start()
console.log('zync1 is online')

// zync1 writes some entries and uploads them to web3.storage
const identity = await getIdentity('zync1', name.key)
const tag = new Uint8Array([122, 122, 122, 121, 110, 99])
const payload = {}
const refs = []

console.log('zync1 is writing some entries')
const e1 = await Entry.create({ identity, tag, payload, refs, next: [] })
const e2 = await Entry.create({ identity, tag, payload, refs, next: [e1.block.cid] })
const e3 = await Entry.create({ identity, tag, payload, refs, next: [e1.block.cid, e2.block.cid] })
const e4 = await Entry.create({ identity, tag, payload, refs, next: [e2.block.cid, e3.block.cid] })
const e5 = await Entry.create({ identity, tag, payload, refs, next: [e1.block.cid, e2.block.cid, e4.block.cid] })
const e6 = await Entry.create({ identity, tag, payload, refs, next: [e1.block.cid, e2.block.cid, e3.block.cid] })
const e7 = await Entry.create({ identity, tag, payload, refs, next: [e4.block.cid, e5.block.cid] }) // notice it does not link e6, there are 2 log heads

const entries1 = [e1, e2, e3, e4, e5, e6, e7]
const heads1 = entries1.map(e => e.block.cid) // hack until i learn car files better
const cid = await zync1.backup(heads1, entries1)
console.log(`zync1 backed up some entries. entry backup cid: ${cid}`)

// zync1 goes offline; zync2 comes online
await zync1.stop()
console.log('zync1 is going to sleep... ZzzzzZzz')
await new Promise(resolve => setTimeout(resolve, 1000))

console.log('zync2 is coming online')
const zync2 = new Zzzync({ local, names: [name.toString()] })
await zync2.start() // watching zync1 name for updates

const reader = await new Promise(resolve => zync2.events.once('car', resolve))

const [root] = await reader.getRoots()
const heads2 = await Block.decode({ bytes: (await reader.get(root)).bytes, codec, hasher })
const entries2 = []
console.log('zync2 is reading entries')
for await (const cid of heads2.value){
  const { bytes: entryBytes } = await reader.get(cid)
  console.log({entryBytes})
  const entryBlock = await Block.decode({ bytes: entryBytes, codec, hasher })
  console.log(entryBlock)
  const { bytes: identityBytes } = await reader.get(entryBlock.value.auth)
  const identityBlock = await Block.decode({ bytes: identityBytes, codec, hasher })
  const identity = await Identity.asIdentity({ block: identityBlock })
  const entry = await Entry.asEntry({ block: entryBlock, identity })
  entries2.push(entry)
}

console.log(`received ${entries2.length}/7 entries`)

await new Promise(resolve => setTimeout(resolve, 1000))
process.exit()
