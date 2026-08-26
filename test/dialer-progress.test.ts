import type { Car } from "@helia/car";
import type { Stream } from "@libp2p/interface";
import { defaultLogger } from "@libp2p/logger";
import { byteStream, streamPair } from "@libp2p/utils";
import { CID } from "multiformats/cid";
import { describe, expect, it } from "vitest";
import { writeCarFile } from "../src/dialer.ts";

const log = defaultLogger().forComponent("test");

// any valid CID; the stub exporter ignores it
const ROOT = CID.parse("bafkqaaa");

describe("writeCarFile onProgress", () => {
  it("reports a running total equal to the bytes written", async () => {
    const chunks = [new Uint8Array(10), new Uint8Array(25), new Uint8Array(7)];
    const exporter = {
      export: async function*() {
        for (const chunk of chunks) yield chunk;
      },
    } as unknown as Pick<Car, "export">;

    const [outbound, inbound] = await streamPair();
    // drain the far side or backpressure stalls the write
    const draining = (async () => {
      for await (const _ of inbound) { /* drain */ }
    })();

    const sent: number[] = [];
    await writeCarFile(byteStream(outbound as Stream), exporter, ROOT, {
      timeoutMs: 5000,
      log,
      onProgress: (total) => sent.push(total),
    });
    await (outbound as Stream).close();
    await draining;

    expect(sent).toEqual([10, 35, 42]);
  });

  it("is optional", async () => {
    const exporter = {
      export: async function*() {
        yield new Uint8Array(4);
      },
    } as unknown as Pick<Car, "export">;

    const [outbound, inbound] = await streamPair();
    const draining = (async () => {
      for await (const _ of inbound) { /* drain */ }
    })();

    await expect(
      writeCarFile(byteStream(outbound as Stream), exporter, ROOT, {
        timeoutMs: 5000,
        log,
      }),
    )
      .resolves
      .toBeUndefined();
    await (outbound as Stream).close();
    await draining;
  });
});
