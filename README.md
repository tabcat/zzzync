# 💤<sub><sup>ync</sup></sub>

<span>
  <a href="https://static.sfdict.com/audio/Z00/Z0026700.mp3" target="_blank" rel="noopener noreferrer">
    <img src="https://camo.githubusercontent.com/b900202928a33c7574d271fb0ef74b60036da10fe81079709e87b86b939ed8e7/68747470733a2f2f6475636b6475636b676f2e636f6d2f6173736574732f69636f6e732f706c61792d627574746f6e2e737667" />
  </a>
  zĭngk
</span>

<br/>
<br/>

sync with peers that have gone to sleep 😴

---

### There's not much here yet but will be [developed over the next 1.5 months](https://github.com/tabcat/zzzync/issues/6)

Zzzync uses [IPLD](https://ipld.io/), [IPNS](https://docs.ipfs.tech/concepts/ipns/), and [Provider Records](https://docs.ipfs.tech/concepts/dht/) to replicate dynamic content over IPFS. Read about the design in [tabcat/dynamic-content](https://github.com/tabcat/dynamic-content).

IPLD is used to store replica data
IPNS is used to point to the latest version of a collaborator's local replica
Provider Records are used to find the [peerIDs](https://docs.libp2p.io/concepts/fundamentals/peers/#peer-id) of collaborators, which can be turned into IPNS names

This work is being funded as part of a [grant](https://github.com/tabcat/rough-opal) by [Protocol Labs](https://protocol.ai)
