# Zzzync Protocol

> Group of utils that make it easy to backup and sync data over libp2p

## Zzzync Push

Push an IPNS Record and a CAR file to a Zzzync handler.

protocol id: `/zzzync/push/1.0.0`

### Stream:

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant H as Handler

  Note over C,H: Protocol: /zzzync/push/1.0.0

  C->>H: Open stream

  C->>H: IPNS Key
  Note left of C: IPNS Key is an Identity Multihash

  alt Key allowed?
    H->>H: Optional authorization check
  else Not allowed
    H-->>C: Reject + close
  end

  C->>H: IPNS Record
  Note left of C: Marshalled IPNS record<br/>with an IPFS value.
  Note right of H: Client record version is >=<br/>to Handler record version.

  C->>H: CAR File
  Note left of C: CAR File has single root.<br/>Root matches IPNS Record value.
  Note right of H: CAR File blocks are UnixFS DFS order.<br/>Handler verifies all blocks descend from root.
  C-->>H: Close stream

  H->>H: Pin CAR blocks
  H->>H: Republish IPNS record
  Note right of H: Handler closes stream after<br/>IPNS/IPFS content is persisted.
  H-->>C: Close stream
```

### Notes

- Only supports IPNS Keys using Identity multihashes (multicodec: 0x00).

<!-- ## Zzzync Push Bitswap

`/zzzync/push/bs`

Triggers a Zzzync server to pull the latest changes from the client over bitswap.
The client sends its latest IPNS Record and the helia node gets all the missing blocks and then pins the new root.

Both send Multihash then IPNS Record first.

- [ ] Check if handlers are safe opening up streams, maybe use the given connection to do it.
  - i bet its fine, might be a reason the connection is given

There needs to be a flag for whether to refresh the IPNS Record
The IPNS Record is always pushed and is used for reading the authenticated IPFS Root and for Authorization. -->


