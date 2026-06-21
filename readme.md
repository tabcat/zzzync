# 💤<sub><sup>ync</sup></sub>

> A libp2p protocol for handing a signed dataset to another peer that can serve it as a verifiable replica of the original publisher.

## Push protocol

Protocol id `/zzzync/push/1.0.0`.

```mermaid
sequenceDiagram
  autonumber
  participant D as Dialer (publisher)
  participant H as Handler

  D->>H: open /zzzync/push/1.0.0
  D->>H: IPNS key
  H->>D: challenge nonce
  D->>H: dialer nonce + signature
  Note over H: signature proves the dialer holds the key
  D->>H: signed IPNS record
  D->>H: CAR file (root matches the record)
  Note over H: every block verified to descend from the root
  Note over H: verified record handed to the app (onReceive) to pin and serve
```

A publisher proves it holds an IPNS key, then streams a signed IPNS record and a CAR of its content to a handler. The handler verifies the signature and the content, then hands the record to your application to pin and serve.

The result is a durable, verifiable copy that stays available even while the publisher is offline.

## Install

```sh
npm install @tabcat/zzzync
```

## Docs and Usage

API reference and examples: https://tabcat.github.io/zzzync

## Credits

Won a [gold medal at HACKFS 2022](https://ethglobal.com/showcase/zzzync-xk96u). Additional work was funded by a [Protocol Labs grant](https://github.com/tabcat/rough-opal). Current work is independent.
