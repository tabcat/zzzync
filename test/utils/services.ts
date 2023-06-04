import { kadDHT } from '@libp2p/kad-dht'
import { ipnsSelector } from 'ipns/selector'
import { ipnsValidator } from 'ipns/validator'
import { identifyService } from 'libp2p/identify'
import type { ServiceMap } from '@libp2p/interface-libp2p'
import type { DualKadDHT } from '@libp2p/kad-dht'
import type { DefaultIdentifyService } from 'libp2p/dist/src/identify/identify'

export interface Services extends ServiceMap {
  identify: DefaultIdentifyService
  dht: DualKadDHT
}

export default {
  identify: identifyService(),
  dht: kadDHT({
    validators: { ipns: ipnsValidator },
    selectors: { ipns: ipnsSelector }
  })
}
