import { fetch } from "@libp2p/fetch";
import { type DefaultLibp2pServices, libp2pDefaults } from "helia";
import type { Libp2pOptions } from "libp2p";
import type { ZzzyncServices } from "../server.js";

const defaultLibp2p = libp2pDefaults();
export const libp2p: Libp2pOptions<DefaultLibp2pServices & ZzzyncServices> = {
	...defaultLibp2p,
	services: {
		...defaultLibp2p.services,
		fetch: fetch(),
	},
};
