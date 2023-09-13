import { type KadDHT, kadDHT } from '@libp2p/kad-dht'
import { ipnsSelector } from 'ipns/selector'
import { ipnsValidator } from 'ipns/validator'
import { identifyService } from 'libp2p/identify'
import type { ServiceMap } from '@libp2p/interface'
import type { DefaultIdentifyService } from 'libp2p/identify/identify'

export interface Services extends ServiceMap {
  identify: DefaultIdentifyService
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
