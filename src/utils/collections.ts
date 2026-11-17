/** The items by the key each one gives: keys in the order their first items come in, and each key's items in their order. */
export function groupBy<Item, Key>(items: Iterable<Item>, keyOf: (item: Item) => Key): Map<Key, Item[]> {
    const groups = new Map<Key, Item[]>();
    for (const item of items) {
        const key = keyOf(item);
        const group = groups.get(key);
        if (group) group.push(item);
        else groups.set(key, [item]);
    }
    return groups;
}

/** The map's value for `key`, set to `createValue()` first when it has none. */
export function getOrInsertComputed<Key, Value>(map: Map<Key, Value>, key: Key, createValue: () => NoInfer<Value>): Value {
    if (!map.has(key)) map.set(key, createValue());
    return map.get(key)!;
}

/**
 * The index of the first item `isPast` holds for, found by binary search: it must hold for none of the items before that one and for all of them after it.
 * `items.length` when it holds for none.
 */
export function partitionPoint<Item>(items: readonly Item[], isPast: (item: Item) => boolean): number {
    let low = 0;
    let high = items.length;
    while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (isPast(items[middle]!)) high = middle;
        else low = middle + 1;
    }
    return low;
}

/** A map that keeps at most `capacity` entries, forgetting the least recently used one to make room for a new one. */
export class LeastRecentlyUsedCache<Key, Value> {
    private readonly entries = new Map<Key, Value>();

    constructor(private readonly capacity: number) {}

    /** The value for `key`, made by `createValue()` first when it has none; either way, it becomes the most recently used. */
    getOrInsertComputed(key: Key, createValue: () => Value): Value {
        const value = this.entries.has(key) ? this.entries.get(key)! : createValue();
        this.entries.delete(key);
        this.entries.set(key, value);
        if (this.entries.size > this.capacity) this.entries.delete(this.entries.keys().next().value!);
        return value;
    }
}
