import { type Car, UnixFSExporter } from "@helia/car";
import type { Stream } from "@libp2p/interface";
import type { ByteStream } from "@libp2p/utils";
import { byteStream, messageStreamToDuplex } from "@libp2p/utils";
import { type IPNSRecord, marshalIPNSRecord } from "ipns";
import * as varint from "uint8-varint";
import { Uint8ArrayList } from "uint8arraylist";
import type { IpnsKey } from "./interface.js";
import { parseRecordValue } from "./utils.js";

async function writeIpnsKey(
	bs: ByteStream<Stream>,
	ipnsKey: IpnsKey,
): Promise<void> {
	await bs.write(ipnsKey.bytes);
}

async function writeIpnsRecord(
	bs: ByteStream<Stream>,
	record: IPNSRecord,
): Promise<void> {
	const marshalledRecord = marshalIPNSRecord(record);
	const recordLength = varint.encode(marshalledRecord.length);
	console.log(recordLength);
	await bs.write(new Uint8ArrayList(recordLength, marshalledRecord));
}

export const createInitiator = (
	exporter: Pick<Car, "export">,
	ipnsKey: IpnsKey,
	record: IPNSRecord,
): ((stream: Stream) => Promise<void>) => {
	const cid = parseRecordValue(record.value);

	return async (stream: Stream): Promise<void> => {
		const bs = byteStream(stream);

		await writeIpnsKey(bs, ipnsKey);
		await writeIpnsRecord(bs, record);

		bs.unwrap();
		const { sink } = messageStreamToDuplex(stream);

		await sink(
			exporter.export(cid, {
				exporter: new UnixFSExporter(),
			}),
		);
	};
};
