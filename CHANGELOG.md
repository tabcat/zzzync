# Changelog

## [4.2.0](https://github.com/tabcat/zzzync/compare/v4.1.0...v4.2.0) (2023-09-16)


### Features

* resolve local names using cache ([f4b18bf](https://github.com/tabcat/zzzync/commit/f4b18bf38f8e661740ce63ad824a026ada4c4c5c))

## [4.1.0](https://github.com/tabcat/zzzync/compare/v4.0.0...v4.1.0) (2023-09-15)


### Features

* **namers/w3:** local resolutions of names ([8fd4760](https://github.com/tabcat/zzzync/commit/8fd47605f3878e4e22b29e83f2a230484e5ccb10))

## [4.0.0](https://github.com/tabcat/zzzync/compare/v3.0.0...v4.0.0) (2023-09-14)


### ⚠ BREAKING CHANGES

* change advertiser interface
* add pinner to zzzync interface

### Features

* add pinner to zzzync interface ([1d23cff](https://github.com/tabcat/zzzync/commit/1d23cffdb8a05b41d7afd7e6da45b832596efa7a))


### Bug Fixes

* catch advertisers/dht query abort error ([d3a5aea](https://github.com/tabcat/zzzync/commit/d3a5aea6c68beefc64b6f3a81f43c9a61fa45608))
* handle sync and async code the same ([277086b](https://github.com/tabcat/zzzync/commit/277086be56a0255125ff76e6d0591b2557a2d506))
* handle w3 name resolution errors ([31ffe91](https://github.com/tabcat/zzzync/commit/31ffe910de56cc46f724fbda96cb838ad0ccf537))
* pinner/w3 uses CarWriter correctly ([3f1b3ec](https://github.com/tabcat/zzzync/commit/3f1b3ec79a8a0ddd02aa2347a381ce0bcdccfd27))
* w3 namer uses passed service option ([20e1ad3](https://github.com/tabcat/zzzync/commit/20e1ad32d6fae6225655c9f23dacc17ef23dadeb))


### Code Refactoring

* change advertiser interface ([7af6741](https://github.com/tabcat/zzzync/commit/7af674178640527e36ea7a37a2163c0d902dcb34))

## [3.0.0](https://github.com/tabcat/zzzync/compare/v2.0.0...v3.0.0) (2023-09-04)


### ⚠ BREAKING CHANGES

* rename w3name to just w3
* rename w3namer and dhtAdvertiser exports
* dht advertiser takes kad-dht not libp2p

### Code Refactoring

* dht advertiser takes kad-dht not libp2p ([d0ee166](https://github.com/tabcat/zzzync/commit/d0ee1667d77f2c275f62e2d92fa60c00114a47ec))
* rename w3name to just w3 ([bb74965](https://github.com/tabcat/zzzync/commit/bb749659725692e1dc1cd956f4942dfcea1fc4df))
* rename w3namer and dhtAdvertiser exports ([45baedd](https://github.com/tabcat/zzzync/commit/45baedd8c46887801bfbea1e7f0a6bb64a84c7f7))

## [2.0.0](https://github.com/tabcat/zzzync/compare/v1.1.0...v2.0.0) (2023-07-17)


### ⚠ BREAKING CHANGES

* optionally stops ephemeral libp2p node

### Features

* optionally stops ephemeral libp2p node ([5fddc7e](https://github.com/tabcat/zzzync/commit/5fddc7e3fec8fa2712d5baebcf8355a5b2cccacd))

## [1.1.0](https://github.com/tabcat/zzzync/compare/v1.0.0...v1.1.0) (2023-07-07)


### Features

* optionally scope the dht to lan|wan ([a835682](https://github.com/tabcat/zzzync/commit/a83568280dd201cd1f597f1332c63e12fd87dc83))


### Bug Fixes

* make dht options optional ([90c6c30](https://github.com/tabcat/zzzync/commit/90c6c30e73994851944443bbcc07328b6a9a461a))

## 1.0.0 (2023-06-17)


### Features

* add toDcid ([3a5e27e](https://github.com/tabcat/zzzync/commit/3a5e27e713c8bddebb1f15c628f33a2652d26836))


### Bug Fixes

* handle async digests in browser ([1495f6a](https://github.com/tabcat/zzzync/commit/1495f6abda16311365f4a81af5c3df1dc17a3e2f))
* ipns resolve handles ipfs prefix ([d3db515](https://github.com/tabcat/zzzync/commit/d3db515ec11ed2f14367b73154ed22281087d4f2))
