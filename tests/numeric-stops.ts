import type {Progress} from "../src/types.ts";
import {remap} from "../src/utils/math.ts";

export interface NumericStop {
    offset: Progress;
    value: number;
}

/** One property's values as numbers in one unit, at offsets from 0 to 1, in order, with a stop at each end. */
export class NumericStops {
    constructor(readonly stops: readonly NumericStop[]) {}

    /** The stop's own value at a stop; linear between the surrounding stops; past either end, it continues the nearest segment, as a spring overshoots. */
    valueAt(offset: Progress): number {
        const stop = this.stops.find(stop => stop.offset === offset);
        if (stop) return stop.value;

        const {start, end} = this.surroundingStops(offset);
        return remap(offset, start.offset, end.offset, start.value, end.value);
    }

    /** The stops on either side of the offset; past either end, the nearest pair. */
    private surroundingStops(offset: Progress): { start: NumericStop; end: NumericStop } {
        const {stops} = this;
        const nextIndex = stops.findIndex(stop => stop.offset > offset);
        const endIndex = nextIndex === -1 ? stops.length - 1 : Math.max(nextIndex, 1);
        return {start: stops[endIndex - 1]!, end: stops[endIndex]!};
    }

    /** The stops strictly between the two offsets, in either order. */
    stopsBetween(fromOffset: Progress, toOffset: Progress): NumericStop[] {
        const lowest = Math.min(fromOffset, toOffset);
        const highest = Math.max(fromOffset, toOffset);
        return this.stops.filter(({offset}) => offset > lowest && offset < highest);
    }
}
