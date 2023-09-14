import { type KadDHT, kadDHT } from '@libp2p/kad-dht'
import { ipnsSelector } from 'ipns/selector'
import { ipnsValidator } from 'ipns/validator'
import { type IdentifyService, identifyService } from 'libp2p/identify'
import type { ServiceMap } from '@libp2p/interface'

export interface Services extends ServiceMap {
  identify: IdentifyService
  dht: KadDHT
}

const services = {
  identify: identifyService(),
  dht: kadDHT({
    validators: { ipns: ipnsValidator },
    selectors: { ipns: ipnsSelector }
  })
}

export default services
