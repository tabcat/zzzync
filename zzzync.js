
import EventEmitter from 'events'
import { Web3Storage } from 'web3.storage'
import * as Name from 'web3.storage/name' // w3name package is not ready yet
import { CarWriter, CarReader } from '@ipld/car'

import * as Block from 'multiformats/block'
import * as codec from '@ipld/dag-cbor'
import { sha256 as hasher } from 'multiformats/hashes/sha2'
import { base32 } from 'multiformats/bases/base32'

const privs = {
  tokens: new WeakMap(),
  names: new WeakMap()
}

class Zzzync {
  constructor ({ local, names }) {
    privs.tokens.set(this, local.token)
    privs.names.set(this, local.key)

    this.client = new Web3Storage({ token: local.token })
    // names is an array of stringified names to check for updates
    this.names = names || []
    this.sequences = new Map()

    this.events = new EventEmitter()
    this.revision = null
    this.started = false
  }

  // for testing; remove later
  static get privs () { return privs }

  async start () {
    if (this.started) {
      return
    }
    this.started = true

    const name = privs.names.get(this)
    this.revision = await Name.resolve(this.client, name).catch(() => null)

    const polling = async (name) => {
      this._poll(name)

      // wait a second
      await new Promise(resolve => setTimeout(resolve, 1000))

      if (this.started) {
        const index = this.names.indexOf(name)
        const next = (index + 1) % this.names.length
        polling(this.names[next])
      }
    }

    // start polling loop
    if (this.names.length) polling(this.names[0])
  }

  async stop () {
    if (!this.started) {
      return
    }
    this.started = false
  }

  // this is a hack until it's possible to listen for updates to a name with websockets
  async _poll (name) {
    let revision
    try {
      revision = await Name.resolve(this.client, Name.parse(name))
    } catch (e) {
      console.error('name resolution failed')
      console.error(e)
    }

    const tracked = this.sequences.get(name.toString())
    if (tracked != null && tracked >= revision.sequence) {
      return
    }

    console.log(`new revision for ${name}, fetching car`)

    this.sequences.set(name, revision.sequence)
    this._getCar(revision.value)
  }

  async _getCar (cid) {
    const res = await this.client.get(cid)
    if (!res.ok) {
      throw new Error(`failed to get ${cid} - [${res.status}] ${res.statusText}`)
    }

    const bytes = new Uint8Array(await res.arrayBuffer())
    const reader = await CarReader.fromBytes(bytes)
    console.log('reading car file')
    for await (const cid of reader.cids()) { console.log(cid) }

    this.events.emit('car', reader)
  }

  async _updateName (cid) {
    const name = privs.names.get(this)
    this.revision = this.revision
      ? await Name.increment(this.revision, cid.toString())
      : await Name.v0(name, cid.toString())

    await Name.publish(this.client, this.revision, name.key)
    return cid
  }

  async backup (heads, entries) {
    const root = await Block.encode({ value: heads, codec, hasher })

    const { writer, out } = await CarWriter.create([root.cid])
    writer.put(root)
    for await (const entry of entries) {
      writer.put(entry.block)
      writer.put(entry.identity.block)
    }
    writer.close()

    const reader = await CarReader.fromIterable(out)
    const cid = await this.client.putCar(reader)
    return this._updateName(cid)
  }
}

export { Zzzync }
