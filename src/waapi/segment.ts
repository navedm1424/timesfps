import type {Easing} from "../easing.ts";
import {linear} from "../easing-specifier.ts";
import type {Oscillation} from "../playback-options.ts";
import type {TrackStop} from "../tracks/track-entries.ts";
import type {Progress} from "../types.ts";
import {invLerp, remap} from "../utils/math.ts";

/**
 * Part of a native effect's iteration: stops played through an easing, over a window of its input time, and placed in time.
 * `startOffset` to `endOffset` are fractions of the time it's placed in, an iteration or a stretch of them,
 * and `windowStart` to `windowEnd` fractions of its easing's input time, which runs backwards when its end comes first.
 */
export class Segment {
    /** Its easing over its window, which keeps its easing's progress. */
    readonly windowedEasing: Easing;

    constructor(
        readonly startOffset: number,
        readonly endOffset: number,
        readonly easing: Easing,
        /** Its values' CSS texts at offsets of its easing's progress, in order. */
        readonly stops: readonly TrackStop<string>[],
        readonly windowStart: number = 0,
        readonly windowEnd: number = 1
    ) {
        this.windowedEasing = easing.segment(windowStart, windowEnd);
    }

    /** One that holds `value` from `startOffset` to `endOffset`. */
    static holding(value: string, startOffset: number, endOffset: number): Segment {
        return new Segment(startOffset, endOffset, linear, [{offset: 0, value}, {offset: 1, value}]);
    }

    /** Whether it starts and ends at the same offset, so its value jumps there. */
    get isJump(): boolean {
        return this.startOffset === this.endOffset;
    }

    /** The progress its window starts from. */
    get startProgress(): Progress {
        return this.windowedEasing.startProgress;
    }

    /** The progress its window ends at. */
    get endProgress(): Progress {
        return this.windowedEasing.endProgress;
    }

    /** The progress at `offset` of the time it's placed in: its start progress before it, and its end progress after it, or where it starts and ends at once. */
    progressAt(offset: number): Progress {
        const {startOffset, endOffset, windowedEasing} = this;
        if (offset >= endOffset) return this.endProgress;
        if (offset <= startOffset) return this.startProgress;
        return windowedEasing.progressAt(invLerp(startOffset, endOffset, offset));
    }

    /** The stops strictly between the two progresses, in either order. */
    stopsBetween(fromProgress: Progress, toProgress: Progress): TrackStop<string>[] {
        const lowest = Math.min(fromProgress, toProgress);
        const highest = Math.max(fromProgress, toProgress);
        return this.stops.filter(({offset}) => offset > lowest && offset < highest);
    }

    /**
     * What of it plays from `start` to `end` of the time it's placed in, its window narrowed to it; undefined when none of it does.
     * A jump stays when it's from `start` up to, but not at, `end`.
     */
    trim(start: number, end: number): Segment | undefined {
        const {startOffset, endOffset, windowStart, windowEnd} = this;
        if (this.isJump) return startOffset >= start && startOffset < end ? this : undefined;
        const trimmedStart = Math.max(startOffset, start);
        const trimmedEnd = Math.min(endOffset, end);
        if (trimmedEnd <= trimmedStart) return undefined;
        if (trimmedStart === startOffset && trimmedEnd === endOffset) return this;

        const windowAt = (offset: number) => remap(offset, startOffset, endOffset, windowStart, windowEnd);
        return new Segment(trimmedStart, trimmedEnd, this.easing, this.stops, windowAt(trimmedStart), windowAt(trimmedEnd));
    }

    /**
     * The same segment in the iteration flipped by `oscillate`, from 1 minus its end to 1 minus its start: flipping its time runs its window backwards,
     * and flipping its values mirrors its window too, so its easing still runs forwards, and moves each stop from its offset to 1 minus it.
     */
    flip(oscillate: Oscillation): Segment {
        const {startOffset, endOffset, easing, stops, windowStart, windowEnd} = this;
        return oscillate === 'time'
            ? new Segment(1 - endOffset, 1 - startOffset, easing, stops, windowEnd, windowStart)
            : new Segment(1 - endOffset, 1 - startOffset, easing, stops.map(({offset, value}) => ({offset: 1 - offset, value})).reverse(), 1 - windowEnd, 1 - windowStart);
    }

    /** The same segment from `startOffset` to `endOffset`. */
    move(startOffset: number, endOffset: number): Segment {
        const {easing, stops, windowStart, windowEnd} = this;
        return new Segment(startOffset, endOffset, easing, stops, windowStart, windowEnd);
    }
}
