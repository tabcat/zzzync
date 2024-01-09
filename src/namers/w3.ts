import { Key } from 'interface-datastore'
import { keys } from 'libp2p-crypto'
import { CID } from 'multiformats/cid'
import * as Name from 'w3name'
import type { Namer } from '../index.js'
import type { Ed25519PeerId } from '@libp2p/interface/peer-id'
import type { Datastore } from 'interface-datastore'
import type { Await } from 'interface-store'
import type W3NameService from 'w3name/service'

export interface RevisionState {
  get(peerId: Ed25519PeerId): Await<Name.Revision | undefined>
  set(peerId: Ed25519PeerId, revision: Name.Revision): Await<void>
}

const ipfsPrefix = '/ipfs/'
const revision2cid = (revision: string): CID => {
  if (!revision.startsWith(ipfsPrefix)) {
    throw new Error('invalid revision: missing /ipfs/ prefix')
  }

  return CID.parse(revision.slice(ipfsPrefix.length))
}
const cid2revision = (cid: CID): string => ipfsPrefix + cid.toString()

export const revisionState = (datastore: Datastore): RevisionState => {
  const get: RevisionState['get'] = async (peerId): Promise<Name.Revision | undefined> => {
    try {
      return Name.Revision.decode(await datastore.get(new Key(peerId.toString())))
    } catch (e) {
      if (String(e) !== 'Error: Not Found') {
        throw e
      }

      return undefined
    }
  }

  const set: RevisionState['set'] = async (peerId, revision): Promise<void> => {
    await datastore.put(new Key(peerId.toString()), Name.Revision.encode(revision))
  }

  return { get, set }
}

const pid2Name = (peerId: Ed25519PeerId): Name.Name =>
  new Name.Name(keys.unmarshalPublicKey(peerId.publicKey))

const publish =
  (service: W3NameService, revisions: RevisionState): Namer['publish'] =>
    async (peerId: Ed25519PeerId, cid: CID) => {
      if (peerId.privateKey == null) {
        throw new Error('namers/w3: unable to publish, peerId.privateKey undefined')
      }

      const name = new Name.WritableName(await keys.unmarshalPrivateKey(peerId.privateKey))

      const revisionValue = cid2revision(cid)
      const existing = await revisions.get(peerId)
      let updated: Name.Revision
      if (existing == null) {
        updated = await Name.v0(name, revisionValue)
      } else {
        updated = await Name.increment(existing, revisionValue)
      }
      await revisions.set(peerId, updated)

      await Name.publish(updated, name.key, service)
    }

const resolve =
  (service: W3NameService, revisions: RevisionState): Namer['resolve'] =>
    async (peerId: Ed25519PeerId) => {
      let revision: Name.Revision | undefined = await revisions.get(peerId)

      if (revision != null) {
        // keys must not be updated concurrently by other devices
        return revision2cid(revision.value)
      }

      try {
        revision = await Name.resolve(pid2Name(peerId), service)
        return revision2cid(revision.value)
      } catch {
        throw new Error('unable to resolve peerId to value')
      }
    }

export function w3Namer (service: W3NameService, revisions: RevisionState): Namer {
  return {
    publish: publish(service, revisions),
    resolve: resolve(service, revisions)
  }
}
