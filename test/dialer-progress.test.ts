import type { Car } from "@helia/car";
import type { Stream } from "@libp2p/interface";
import { defaultLogger } from "@libp2p/logger";
import { byteStream, streamPair } from "@libp2p/utils";
import { CID } from "multiformats/cid";
import type { ProgressEvent } from "progress-events";
import { describe, expect, it } from "vitest";
import type { ZzzyncDialProgressEvents } from "../src/dialer.ts";
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

    const events: ZzzyncDialProgressEvents[] = [];
    await writeCarFile(byteStream(outbound as Stream), exporter, ROOT, {
      timeoutMs: 5000,
      log,
      onProgress: (evt) => events.push(evt),
    });
    await (outbound as Stream).close();
    await draining;

    // an ecosystem-shaped ProgressEvent, not a bare number, so a caller can
    // multiplex it with libp2p's own dial events off one callback
    expect(events.map((e) => e.type)).toEqual([
      "zzzync:dialer:car:chunk",
      "zzzync:dialer:car:chunk",
      "zzzync:dialer:car:chunk",
    ]);
    expect(events.map((e) => e.detail.sent)).toEqual([10, 35, 42]);
  });

  it("emits events a libp2p progress listener can consume unchanged", async () => {
    const exporter = {
      export: async function*() {
        yield new Uint8Array(4);
      },
    } as unknown as Pick<Car, "export">;

    const [outbound, inbound] = await streamPair();
    const draining = (async () => {
      for await (const _ of inbound) { /* drain */ }
    })();

    // the shape libp2p hands its own listeners: { type, detail }
    const seen: Array<ProgressEvent<string, unknown>> = [];
    await writeCarFile(byteStream(outbound as Stream), exporter, ROOT, {
      timeoutMs: 5000,
      log,
      onProgress: (evt) => seen.push(evt),
    });
    await (outbound as Stream).close();
    await draining;

    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveProperty("type");
    expect(seen[0]).toHaveProperty("detail");
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
