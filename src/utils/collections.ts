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
export function getOrInsert<Key, Value>(map: Map<Key, Value>, key: Key, createValue: () => NoInfer<Value>): Value {
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

/** Pops the items off the top of `stack` while `shouldPop` holds for the top one, and gives them in the order they're popped. */
export function popWhile<Item>(stack: Item[], shouldPop: (item: Item) => boolean): Item[] {
    const popped: Item[] = [];
    while (stack.length > 0 && shouldPop(stack.at(-1)!)) popped.push(stack.pop()!);
    return popped;
}

/** Shifts the items off the front of `queue` while `shouldShift` holds for the front one, and gives them in the order they're shifted. */
export function shiftWhile<Item>(queue: Item[], shouldShift: (item: Item) => boolean): Item[] {
    const shifted: Item[] = [];
    while (queue.length > 0 && shouldShift(queue[0]!)) shifted.push(queue.shift()!);
    return shifted;
}
