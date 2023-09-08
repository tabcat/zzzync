import { CarWriter, CarReader } from '@ipld/car'
import { CID } from 'multiformats'
import type { Blockstore, Pair } from 'interface-blockstore'
import type { AwaitIterable } from 'interface-store'
import type { Web3Storage } from 'web3.storage'

export class Web3StoragePinner implements Blockstore {
  constructor (readonly client: Web3Storage) {}

  async has (cid: CID): Promise<boolean> {
    return this.client.status(cid.toString()) != null
  }

  async put (cid: CID, bytes: Uint8Array): Promise<CID> {
    const { writer, out } = CarWriter.create(cid)

    void writer.put({ cid, bytes })
    void writer.close()

    const reader = await CarReader.fromIterable(out)
    // @ts-expect-error Types of parameters 'key' and 'key' are incompatible.
    await this.client.putCar(reader)

    return cid
  }

  async * putMany (source: AwaitIterable<Pair>): AsyncIterable<CID> {
    for await (const { cid, block } of source) {
      yield this.put(cid, block)
    }
  }

  async get (cid: CID): Promise<Uint8Array> {
    const response = await this.client.get(cid.toString())

    if (response == null) {
      throw new Error('response was null')
    }

    if (response.ok != null) {
      throw new Error('failed to get block ' + cid.toString())
    }

    const carBytes = new Uint8Array(await response.arrayBuffer())
    const reader = await CarReader.fromBytes(carBytes)
    const block = await reader.get(cid)

    if (block == null) {
      throw new Error('block for cid not found in car')
    }

    return block.bytes
  }

  async * getMany (source: AwaitIterable<CID>): AsyncIterable<Pair> {
    for await (const cid of source) {
      const bytes = await this.get(cid)
      yield { cid, block: bytes }
    }
  }

  async delete (cid: CID): Promise<void> {
    await this.client.delete(cid.toString())
  }

  async * deleteMany (source: AwaitIterable<CID>): AsyncIterable<CID> {
    for await (const cid of source) {
      await this.delete(cid)
      yield cid
    }
  }

  async * getAll (): AsyncIterable<Pair> {
    for await (const { cid: cidString } of this.client.list()) {
      const cid = CID.parse(cidString)
      yield { cid, block: await this.get(cid) }
    }
  }
}

export const w3Pinner = (client: Web3Storage): Web3StoragePinner => new Web3StoragePinner(client)
