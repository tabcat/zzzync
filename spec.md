
# Zzzync Spec Document

This document is meant to provide clarity on zzzync as a protocol.

Protocol Version: `1.0.0-beta`

---

<br/>

## DCID

DCID are a definition made by Zzzync and are not recognized as a separate format by IPFS.
They are of the same format as CIDs but are created differently.
DCID are created by taking the CID of a manifest/setup document for some dynamic content, then prefixing `'/dcoi/'` decoded utf-8 bytes to the CID multihash, and then hashing into a different CID.

> 'dcoi' is an acronym meaning *dynamic content over ipfs*

DCID format:

```
<0x01 (CIDv1)><0x55 (multicode raw)><sha256(<'/dcoi/' decoded utf-8><manifest CID multihash>)>
```

---
> **Q:** Why not just use `<'/dcoi/' decoded utf-8><manifest CID multihash>` as the routing key. Why convert it back to a CID?

> **A:** The kad-dht api in javascript makes working with CIDs easier. As the protocol matures this may be changed.
---

<br/>

## PeerId

A [PeerId](https://github.com/libp2p/specs/blob/master/peer-ids/peer-ids.md) is a Libp2p definition.
They are used to identify nodes on the network and are made of a cryptographic keypair.
They are unique to a device and must not be shared.

<br/>

## Advertisers

Advertisers are used to point from a DCID to PeerIds.
Advertisers can use any system to do so.
There may be multiple advertisers to use and defined under this protocol and they can be used together.

Advertisers need only re-advertise when the system requires it, to keep the advertisements available.

### DHT Advertiser

The DHT advertiser uses the IPFS DHT's Provider Records to point from DCIDs to PeerIds.
Each record points to a different PeerId and records stay on the network for a maximum of 48hours.

The `ADD_PROVIDER` query is used to advertise that a PeerId is the provider of a DCID.
The `GET_PROVIDERS` query is used to discover PeerIds that are providing a DCID.

The [IPFS DHT spec](https://github.com/libp2p/specs/tree/master/kad-dht) provides further information.

<br/>

## Namers

Namers are used to point from a PeerId to a CID.
The CID is the latest version of some dynamic content.
Namers can use any system that provides verifiable guarantees of a mutable PeerId -> CID mapping.
There may be multiple namers to use and defined under this protocol

Namers need only republish after a change has been made to a local replica, changing its CID.

### IPNS Namer

The IPNS namer uses the Interplanetary Name System to resolve PeerIds to CIDs.

[IPNS spec](https://specs.ipfs.tech/ipns/ipns-record/)

IPNS Records have a value field which is encoded as bytes and can contain something other than a CID.
For Zzzync's purpose there should only ever be IPFS path here, encoded utf-8.
An immutable IPFS path is utf-8 encoded string that includes a multibase encoded CID with an `/ipfs/` prefix:

```
/ipfs/<multibase encoded CID>
```

### W3Name Namer

The W3Name namer uses the W3Name system to resolve PeerIds to CIDs.
W3Name system was built to be a substitute for IPNS.

The design and records used are very similar so the IPNS Namer section on value field format also applies here.

PeerIds are made of cryptographic keys.
The private key of the PeerId being used must be used to sign the W3Name records.

<br/>

## Replication Protocol

### Advertisement

After a change has been made to a local replica and the replica data has been uploaded to another machine:

1. Use Namer to publish device unique PeerId -> CID of replica.
2. Use Advertiser to advertise DCID -> PeerId

### Discovery

1. Use Advertiser to query PeerIds for DCID.
2. Use Namer for each PeerId to resolve replica CIDs.

If the replica data for the CID has been uploaded to another machine offline replication can be completed.

<br/>

## Replica Hosts

For offline discovery to be possible the records created by the Advertisers/Namers must be available.
For offline replication the referenced replica data remain available.
Without both offline collaboration cannot occur in this context.

This document does not specify how data should be hosted for this purpose.
It only specifies how to advertise and discover the latest versions for some dynamic content.
