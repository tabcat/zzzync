import type { Fetch } from "@libp2p/fetch";
import type { ServiceMap } from "@libp2p/interface";
import type { Keychain } from "@libp2p/keychain";
import type { Blockstore } from "interface-blockstore";
import type { AbortOptions } from "interface-store";
import type { IPNSRecord } from "ipns";
import type { MultihashDigest } from "multiformats/interface";
import type { CODEC_IDENTITY, CODEC_SHA2_256 } from "./constants.js";

export type Blockfetcher = Pick<Blockstore, "get">;

export interface IpnsRecordFetcher {
	get(ipnsKey: IpnsKey, options: AbortOptions): Promise<IPNSRecord>;
}

export interface ZzzyncUploader {
	upload(): Promise<void>;
}

export type IpnsKey = MultihashDigest<
	typeof CODEC_IDENTITY | typeof CODEC_SHA2_256
>;

export interface ZzzyncServices extends ServiceMap {
	fetch: Fetch;
	keychain: Keychain;
}

export type AllowFn = (ipnsKey: IpnsKey) => Promise<boolean> | boolean;
