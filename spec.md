# Zzzync Protocol

> The `/zzzync/push/1.0.0` wire protocol: a publisher pushes a signed IPNS record and a CAR file to a handler.

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
  Note left of C: IPNS Key is an Identity Multihash of an<br/>Ed25519 or secp256k1 public key.

  alt Key allowed?
    H->>H: Optional authorization check
  else Not allowed
    H-->>C: Reject + close
  end

  H->>C: Challenge nonce
  Note right of H: 32 random bytes.

  C->>H: Dialer nonce + signature
  Note left of C: 32-byte dialer nonce, then a 64-byte<br/>signature over the challenge.
  Note right of H: Verified with the public key from the IPNS<br/>Key — proves the client holds the key.

  C->>H: IPNS Record
  Note left of C: Marshalled IPNS record<br/>with an IPFS value.
  Note right of H: Client record version is >=<br/>to Handler record version.

  C->>H: CAR File
  Note left of C: CAR File has single root.<br/>Root matches IPNS Record value.
  Note right of H: CAR File blocks are UnixFS DFS order.<br/>Handler verifies all blocks descend from root.
  C-->>H: Close stream

  H->>H: Pin CAR blocks
  H->>H: Republish IPNS record
  Note right of H: Pin + republish are delegated to the<br/>application via the onReceive callback; the handler<br/>closes the stream once it completes.
  H-->>C: Close stream
```

### Challenge

Before sending any record or blocks the Client proves it holds the private key
for the IPNS Key. The Handler sends a 32-byte random nonce; the Client replies
with its own 32-byte nonce followed by a 64-byte signature over the
concatenation:

```
protocol-id || handler-peer-id-multihash || ipns-key-multihash || handler-nonce || dialer-nonce
```

- **protocol-id** — UTF-8 bytes of the zzzync protocol id (`/zzzync/push/1.0.0`).
- **handler-peer-id-multihash**, **ipns-key-multihash** — raw multihash bytes.
- **handler-nonce**, **dialer-nonce** — 32 bytes each.

The Handler verifies the signature with the public key recovered from the IPNS
Key. Only Ed25519 and secp256k1 keys are supported; secp256k1 signatures use
64-byte compact encoding (not DER).

### Notes

- Only supports IPNS Keys using Identity multihashes (multicodec: 0x00).
