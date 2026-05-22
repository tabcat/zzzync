export interface KeyedMutex {
  /**
   * Run `fn` with exclusive access to `key`. Calls sharing a key run one at a
   * time in arrival order; calls with different keys run concurrently. The lock
   * is always released when `fn` settles, including when it throws.
   */
  acquire: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  /**
   * Number of keys currently locked or queued. Drops back to 0 once every
   * key is idle.
   */
  readonly size: number;
}

/**
 * A mutex that serializes async work per string key.
 *
 * Used to make read-modify-write sequences (e.g. pin metadata updates) atomic
 * with respect to a single CID without blocking work on unrelated CIDs.
 */
export const createKeyedMutex = (): KeyedMutex => {
  // Maps a key to the tail of its queue: a promise that resolves once the
  // currently-holding call releases. A new caller chains onto the tail.
  const tails = new Map<string, Promise<void>>();

  return {
    get size() {
      return tails.size;
    },

    async acquire<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const previous = tails.get(key) ?? Promise.resolve();

      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tail = previous.then(() => gate);
      tails.set(key, tail);

      await previous;
      try {
        return await fn();
      } finally {
        release();
        // Clean up only if no later caller has extended the queue. There is no
        // await between release() and this check, so no other call can slip in.
        if (tails.get(key) === tail) {
          tails.delete(key);
        }
      }
    },
  };
};
