/** Add one value while pruning expired entries and enforcing a hard key limit. */
export function setBoundedCache<Key, Value>(
  cache: Map<Key, Value>,
  key: Key,
  value: Value,
  options: {
    maxEntries: number;
    expired?: (value: Value) => boolean;
  },
): void {
  if (options.expired) {
    for (const [candidate, cached] of cache) {
      if (options.expired(cached)) cache.delete(candidate);
    }
  }
  cache.delete(key);
  while (cache.size >= options.maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(key, value);
}
