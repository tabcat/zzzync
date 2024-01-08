import { ipnsSelector, ipnsValidator } from '@helia/ipns'
import { type Identify, identify } from '@libp2p/identify'
import { type KadDHT, kadDHT, removePublicAddressesMapper } from '@libp2p/kad-dht'
import { lanKadProtocol } from './protocols.js'
import type { ServiceMap } from '@libp2p/interface'

export interface Services extends ServiceMap {
  identify: Identify
  dht: KadDHT
}

const services = {
  identify: identify(),

  dht: kadDHT({
    protocol: lanKadProtocol,
    peerInfoMapper: removePublicAddressesMapper,
    validators: { ipns: ipnsValidator },
    selectors: { ipns: ipnsSelector },
    clientMode: false
  })
}

export default services
