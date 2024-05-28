# 💤<sub><sup>ync</sup></sub>

<span>
  <a href="https://static.sfdict.com/audio/Z00/Z0026700.mp3" target="_blank" rel="noopener noreferrer">
    <img src="https://em-content.zobj.net/source/sony/336/speaker-high-volume_1f50a.png" />
  </a>
  zĭngk
</span>

<br/>
<br/>

sync with peers that have gone to sleep 😴

---

<br/>

Zzzync uses [IPLD](https://ipld.io/), [IPNS](https://docs.ipfs.tech/concepts/ipns/), and [Provider Records](https://docs.ipfs.tech/concepts/dht/) to replicate dynamic content over IPFS. Read about the design in [tabcat/dynamic-content](https://github.com/tabcat/dynamic-content).

IPLD is used to store replica data
IPNS is used to point to the latest version of a collaborator's local replica
Provider Records are used to find the [peerIDs](https://docs.libp2p.io/concepts/fundamentals/peers/#peer-id) of collaborators, which can be turned into IPNS names

## API Docs

https://tabcat.github.io/zzzync/

## Spec

https://github.com/tabcat/zzzync/blob/master/spec.md

---

This work is being funded as part of a [grant](https://github.com/tabcat/rough-opal) by [Protocol Labs](https://protocol.ai)
