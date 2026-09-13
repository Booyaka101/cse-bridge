/**
 * The trim shared by the two in-memory caches: query result sets in
 * searxng.ts, fetched pages in pagemap.ts.
 *
 * What they cache and when they reorder an entry differs; dropping expired
 * entries and then capping the size does not.
 */

export interface Expiring {
  expiresAt: number;
}

/** Drop expired entries, then entries from the front, down to `max`. */
export function trim<V extends Expiring>(cache: Map<string, V>, now: number, max: number): void {
  for (const [key, value] of cache) {
    if (value.expiresAt <= now) cache.delete(key);
  }
  // Map iterates in insertion order, so the front is the oldest insert, or the
  // least recently used where the caller re-inserts on a hit.
  while (cache.size > max) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}
