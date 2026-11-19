import type {Seconds} from "../types.ts";

/** An entry whose missing values are yet to be resolved. */
export interface MissingValuesUnresolvedEntry<Value, Resolved extends MissingValuesResolvedEntry<Value>> {
    /** It resolved, each missing value taking `valueUnderneath`'s value at its time. */
    resolve(valueUnderneath: (time: Seconds) => Value): Resolved;
}

/** An entry whose missing values are resolved. */
export interface MissingValuesResolvedEntry<Value> {
    /** Its value at `time`: while it runs, or where it holds its value; undefined elsewhere. */
    valueAt(time: Seconds): Value | undefined;
}

/**
 * Resolves entries laid over each other in the order they're given, each over the ones before it.
 * Each missing value takes the value underneath it: the topmost value of the ones under its entry at its time, or, with none, `valueUnderneath`'s.
 */
export function resolveMissingValues<Value, Resolved extends MissingValuesResolvedEntry<Value>>(
    entries: readonly MissingValuesUnresolvedEntry<Value, Resolved>[],
    valueUnderneath: (time: Seconds) => Value
): Resolved[] {
    const resolved: Resolved[] = [];
    for (const entry of entries)
        resolved.push(entry.resolve(time => topmostValueAt(resolved, time) ?? valueUnderneath(time)));
    return resolved;
}

/** The value of the topmost of the entries that has one at `time`. */
function topmostValueAt<Value>(entries: readonly MissingValuesResolvedEntry<Value>[], time: Seconds): Value | undefined {
    for (let index = entries.length - 1; index >= 0; index--) {
        const value = entries[index]!.valueAt(time);
        if (value !== undefined) return value;
    }
    return undefined;
}
