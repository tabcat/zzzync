import { Web3Storage } from 'web3.storage'
import { w3Pinner } from '../../src/pinners/w3.js'
import { interfaceBlockstoreTests as suite } from './pinner.js'

const token = process.env.WEB3_STORAGE_TOKEN

// eslint-disable-next-line no-console
console.log(token)
describe('pinners/w3.ts', () => {
  if (token != null) {
    suite({
      setup () {
        const client = new Web3Storage({ token })
        return w3Pinner(client)
      },
      teardown () {}
    })
  }
})
