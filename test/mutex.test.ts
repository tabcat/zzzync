import { describe, expect, it } from "vitest";
import { createKeyedMutex as createKeyedMutexFromIndex } from "../src/index.js";
import { createKeyedMutex } from "../src/mutex.js";

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("createKeyedMutex", () => {
  it("serializes access for the same key", async () => {
    const mutex = createKeyedMutex();
    const order: string[] = [];

    const a = mutex.acquire("k", async () => {
      order.push("a-start");
      await delay(20);
      order.push("a-end");
    });
    const b = mutex.acquire("k", async () => {
      order.push("b-start");
      await delay(1);
      order.push("b-end");
    });

    await Promise.all([a, b]);

    // b must not start until a has fully finished
    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  it("allows concurrent access for different keys", async () => {
    const mutex = createKeyedMutex();
    const order: string[] = [];

    const a = mutex.acquire("k1", async () => {
      order.push("a-start");
      await delay(20);
      order.push("a-end");
    });
    const b = mutex.acquire("k2", async () => {
      order.push("b-start");
      await delay(1);
      order.push("b-end");
    });

    await Promise.all([a, b]);

    // different keys run concurrently, so the faster one (b) finishes first
    expect(order).toEqual(["a-start", "b-start", "b-end", "a-end"]);
  });

  it("returns the callback result", async () => {
    const mutex = createKeyedMutex();
    await expect(mutex.acquire("k", async () => 42)).resolves.toBe(42);
  });

  it("releases the lock when the callback throws", async () => {
    const mutex = createKeyedMutex();

    await expect(mutex.acquire("k", async () => {
      throw new Error("boom");
    }))
      .rejects
      .toThrow("boom");

    // the lock is released even though the callback threw
    await expect(mutex.acquire("k", async () => "ok")).resolves.toBe("ok");
  });

  it("does not leak internal state once keys are idle", async () => {
    const mutex = createKeyedMutex();

    const held = mutex.acquire("k", async () => {
      // while held, the key is tracked
      expect(mutex.size).toBe(1);
      await delay(5);
    });
    await held;

    expect(mutex.size).toBe(0);
  });
});

describe("createKeyedMutex (public export)", () => {
  it("is re-exported from the package index", () => {
    expect(typeof createKeyedMutexFromIndex).toBe("function");
    const mutex = createKeyedMutexFromIndex();
    expect(mutex.size).toBe(0);
  });
});
