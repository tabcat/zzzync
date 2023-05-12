import { keys } from 'libp2p-crypto'
import { base32 } from 'multiformats/bases/base32'
import { CID } from 'multiformats/cid'
import * as Name from 'w3name'
import type { Namer } from '../index.js'
import type { Ed25519PeerId } from '@libp2p/interface-peer-id'
import type { Await } from 'interface-store'
import type W3NameService from 'w3name/service'

interface RevisionState {
  get: (peerId: string) => Await<Name.Revision>
  set: (peerId: string, revision: Name.Revision) => Await<void>
}

const pid2Name = (peerId: Ed25519PeerId): Name.Name =>
  new Name.Name(keys.unmarshalPublicKey(peerId.publicKey))

const publish =
  (service: W3NameService, revisions: RevisionState): Namer['publish'] =>
    async (peerId: Ed25519PeerId, value: CID) => {
      if (peerId.privateKey == null) {
        throw new Error()
      }

      const name = new Name.WritableName(await keys.unmarshalPrivateKey(peerId.privateKey))

      const revisionValue = value.toString(base32)
      const existing = await revisions.get(peerId.toString())
      let updated: Name.Revision
      if (existing == null) {
        updated = await Name.v0(name, revisionValue)
      } else {
        updated = await Name.increment(existing, revisionValue)
      }
      await revisions.set(peerId.toString(), updated)

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
