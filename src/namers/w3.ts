import { Key } from 'interface-datastore'
import { keys } from 'libp2p-crypto'
import { base32 } from 'multiformats/bases/base32'
import { CID } from 'multiformats/cid'
import * as Name from 'w3name'
import type { Namer } from '../index.js'
import type { Ed25519PeerId } from '@libp2p/interface-peer-id'
import type { BaseDatastore } from 'datastore-core'
import type { Await } from 'interface-store'
import type W3NameService from 'w3name/service'

interface RevisionState {
  get: (peerId: Ed25519PeerId) => Await<Name.Revision | undefined>
  set: (peerId: Ed25519PeerId, revision: Name.Revision) => Await<void>
}

export const revisionState = (datastore: BaseDatastore): RevisionState => {
  const get: RevisionState['get'] = (peerId): Await<Name.Revision | undefined> => {
    try {
      const datastoreGet = datastore.get(new Key(peerId.toString()))

      return datastoreGet instanceof Promise
        ? datastoreGet.then(Name.Revision.decode).catch(() => undefined)
        : Name.Revision.decode(datastoreGet)
    } catch (e) {
      if (String(e) !== 'Error: Not Found') {
        throw e
      }

      return undefined
    }
  }

  const set: RevisionState['set'] = (peerId, revision): Await<void> => {
    const datastorePut = datastore.put(new Key(peerId.toString()), Name.Revision.encode(revision))

    return datastorePut instanceof Promise
      ? datastorePut.then(() => {})
      : undefined
  }

  return { get, set }
}

const pid2Name = (peerId: Ed25519PeerId): Name.Name =>
  new Name.Name(keys.unmarshalPublicKey(peerId.publicKey))

const publish =
  (service: W3NameService, revisions: RevisionState): Namer['publish'] =>
    async (peerId: Ed25519PeerId, value: CID) => {
      if (peerId.privateKey == null) {
        throw new Error('namers/w3: unable to publish, peerId.privateKey undefined')
      }

      const name = new Name.WritableName(await keys.unmarshalPrivateKey(peerId.privateKey))

      const revisionValue = value.toString(base32)
      const existing = await revisions.get(peerId)
      let updated: Name.Revision
      if (existing == null) {
        updated = await Name.v0(name, revisionValue)
      } else {
        updated = await Name.increment(existing, revisionValue)
      }
      await revisions.set(peerId, updated)

      await Name.publish(updated, name.key)
    }
const resolve =
  (service: W3NameService): Namer['resolve'] =>
    async (peerId: Ed25519PeerId) =>
      Name.resolve(pid2Name(peerId), service)
        .then((revision: Name.Revision) => CID.parse(revision.value))

export function namer (service: W3NameService, revisions: RevisionState): Namer {
  return {
    publish: publish(service, revisions),
    resolve: resolve(service)
  }
}
