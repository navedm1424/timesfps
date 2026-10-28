import type {CSSValue, RawTweenStops} from "./dom/mapping.ts";
import type {Progress} from "./types.ts";
import {sortedEntriesOf} from "./utils/records.ts";

/** A `null` value is the value underneath: at 0, as the entry starts; at 1, as it ends. */
export interface TweenStop {
    offset: Progress;
    value: CSSValue | null;
}

/**
 * One property's values at offsets from 0 to 1, in order, with a stop at each end.
 * A missing 0 is the value underneath as the entry starts, and a missing 1 is the value underneath as it ends.
 */
export class TweenStops {
    private constructor(readonly stops: readonly TweenStop[]) {}

    /** The stops of one of the forms; a single value is the last, as in WAAPI, and a `null` between the ends is left out. */
    static of(property: string, rawStops: RawTweenStops): TweenStops {
        const given: [Progress, CSSValue | null][] = typeof rawStops !== 'object'
            ? [[1, rawStops]]
            : Array.isArray(rawStops)
                ? listedStopsOf(rawStops)
                : sortedEntriesOf(rawStops as { [offset: number]: CSSValue | null });

        for (const [offset] of given) {
            if (!(offset >= 0 && offset <= 1))
                throw new RangeError(`"${property}" has a value at ${offset}, outside the 0–1 range.`);
        }
        const stops: TweenStop[] = given.flatMap(([offset, value]) => value === null && offset !== 0 && offset !== 1 ? [] : [{offset, value}]);
        if (stops.every(({value}) => value === null)) throw new TypeError(`"${property}" has no values.`);

        if (stops[0]!.offset !== 0) stops.unshift({offset: 0, value: null});
        if (stops.at(-1)!.offset !== 1) stops.push({offset: 1, value: null});
        return new TweenStops(stops);
    }

    /** The value throughout. */
    static constant(value: CSSValue | null): TweenStops {
        return new TweenStops([{offset: 0, value}, {offset: 1, value}]);
    }

    get startValue(): CSSValue | null {
        return this.stops[0]!.value;
    }

    get endValue(): CSSValue | null {
        return this.stops.at(-1)!.value;
    }

    /** The value of the stop at exactly the offset, if there's one. */
    get(offset: Progress): CSSValue | null | undefined {
        const stop = this.stops.find(stop => stop.offset === offset);
        return stop ? stop.value : undefined;
    }

    /** The same stops with another value at the offset, which must already have a stop. */
    withValueAt(offset: Progress, value: CSSValue | null): TweenStops {
        return new TweenStops(this.stops.map(stop => stop.offset === offset ? {offset, value} : stop));
    }

    /** The same values played backwards: each moves from its offset to 1 minus it. */
    reverse(): TweenStops {
        return new TweenStops(this.stops.map(({offset, value}) => ({offset: 1 - offset, value})).reverse());
    }
}

function listedStopsOf(values: readonly (CSSValue | null)[]): [Progress, CSSValue | null][] {
    if (values.length === 1) return [[1, values[0]!]];
    return values.map((value, index) => [index / (values.length - 1), value]);
}
