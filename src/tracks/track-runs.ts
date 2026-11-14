import type {Easing} from "../easing.ts";
import {linear} from "../easing-specifier.ts";
import type {Progress, Seconds} from "../types.ts";
import {partitionPoint} from "../utils/collections.ts";
import {clamp, invLerp, lerp, remap} from "../utils/math.ts";
import {type InterpolationToken, valueBetween} from "./track-values.ts";

/**
 * What every other iteration of an oscillating repeat flips: its time, so it plays backwards,
 * or its values, so it runs from the end values to the start ones with its easing forwards.
 */
export type Oscillation = 'time' | 'values';

/** When a run starts, how long each of its iterations lasts, and how it repeats; one without duration doesn't repeat. */
export interface TrackEntry {
    /** After the outermost definition starts. */
    start: Seconds;
    duration: Seconds;
    /** How many iterations follow its first; `Infinity` repeats forever. */
    repeatCount: number;
    /** How long it holds the value it ends on before each repeat. */
    repeatDelay: Seconds;
    /** Without it, every repeat starts over. */
    oscillate?: Oscillation;
}

/** Whether it repeats; one without duration never does. */
export function repeats({repeatCount}: TrackEntry): boolean {
    return repeatCount > 0;
}

/** Whether it repeats forever; one without duration never does. */
export function repeatsForever({repeatCount}: TrackEntry): boolean {
    return repeatCount === Infinity;
}

export interface TrackStop<Value> {
    offset: Progress;
    value: Value;
}

/**
 * Stops played through an easing, over a window of its input time, and placed in time: `startOffset` to `endOffset` are fractions of the time
 * it's placed in, a run's iteration or a part, and `windowStart` to `windowEnd` fractions of its easing's input time, which runs backwards when its end comes first.
 */
export class TrackClip<Value> {
    /** Its easing over its window, which keeps its easing's progress. */
    readonly windowedEasing: Easing;

    constructor(
        readonly startOffset: number,
        readonly endOffset: number,
        readonly easing: Easing,
        /** Its values at offsets of its easing's progress, in order: between two stops, the value runs linearly with the progress, and past the outer ones, it continues the nearest two. */
        readonly stops: readonly TrackStop<Value>[],
        readonly windowStart: number = 0,
        readonly windowEnd: number = 1
    ) {
        this.windowedEasing = easing.segment(windowStart, windowEnd);
    }

    /** Whether it starts and ends at the same offset, so its value jumps there. */
    get isJump(): boolean {
        return this.startOffset === this.endOffset;
    }

    /** The value at the progress its window starts from. */
    get startValue(): Value | InterpolationToken<Value> {
        return this.valueAtProgress(this.windowedEasing.startProgress);
    }

    /** The value at the progress its window ends at. */
    get endValue(): Value | InterpolationToken<Value> {
        return this.valueAtProgress(this.windowedEasing.endProgress);
    }

    /** The value at `offset` of the time it's placed in: its start value before it, and its end value after it, or where it starts and ends at once. */
    valueAt(offset: number): Value | InterpolationToken<Value> {
        const {startOffset, endOffset, windowedEasing} = this;
        if (offset >= endOffset) return this.endValue;
        if (offset <= startOffset) return this.startValue;
        return this.valueAtProgress(windowedEasing.progressAt(invLerp(startOffset, endOffset, offset)));
    }

    /** The stop's own value at a stop; otherwise the value between the stops around the progress, or between the nearest two past either end. */
    valueAtProgress(progress: Progress): Value | InterpolationToken<Value> {
        const {stops} = this;
        const atOrAfterIndex = partitionPoint(stops, stop => stop.offset >= progress);
        const stopThere = stops[atOrAfterIndex];
        if (stopThere?.offset === progress) return stopThere.value;
        if (stops.length === 1) return stops[0]!.value;

        const endIndex = clamp(atOrAfterIndex, 1, stops.length - 1);
        const start = stops[endIndex - 1]!;
        const end = stops[endIndex]!;
        return valueBetween(start.value, end.value, invLerp(start.offset, end.offset, progress));
    }

    /** The stops strictly between the two progresses, in either order. */
    stopsBetween(fromProgress: Progress, toProgress: Progress): TrackStop<Value>[] {
        const lowest = Math.min(fromProgress, toProgress);
        const highest = Math.max(fromProgress, toProgress);
        return this.stops.filter(({offset}) => offset > lowest && offset < highest);
    }

    /**
     * What of it plays from `start` to `end` of the time it's placed in, its window narrowed to it; undefined when none of it does.
     * A jump stays when it's from `start` up to, but not at, `end`.
     */
    trim(start: number, end: number): TrackClip<Value> | undefined {
        const {startOffset, endOffset, windowStart, windowEnd} = this;
        if (this.isJump) return startOffset >= start && startOffset < end ? this : undefined;
        const trimmedStart = Math.max(startOffset, start);
        const trimmedEnd = Math.min(endOffset, end);
        if (trimmedEnd <= trimmedStart) return undefined;
        if (trimmedStart === startOffset && trimmedEnd === endOffset) return this;

        function windowAt(offset: number) {
            return remap(offset, startOffset, endOffset, windowStart, windowEnd);
        }
        return new TrackClip(trimmedStart, trimmedEnd, this.easing, this.stops, windowAt(trimmedStart), windowAt(trimmedEnd));
    }

    /**
     * The same clip in the iteration flipped by `oscillate`, from 1 minus its end to 1 minus its start:
     * flipping its time runs its window backwards, and flipping its values moves each stop from its offset to 1 minus it.
     */
    flip(oscillate: Oscillation): TrackClip<Value> {
        const {startOffset, endOffset, easing, stops, windowStart, windowEnd} = this;
        return oscillate === 'time'
            ? new TrackClip(1 - endOffset, 1 - startOffset, easing, stops, windowEnd, windowStart)
            : new TrackClip(1 - endOffset, 1 - startOffset, easing, stops.map(({offset, value}) => ({offset: 1 - offset, value})).reverse(), windowStart, windowEnd);
    }

    /** The same clip from `startOffset` to `endOffset`. */
    move(startOffset: number, endOffset: number): TrackClip<Value> {
        const {easing, stops, windowStart, windowEnd} = this;
        return new TrackClip(startOffset, endOffset, easing, stops, windowStart, windowEnd);
    }

    /** The same clip with each value transformed. */
    map<Other>(transform: (value: Value) => Other): TrackClip<Other> {
        const {startOffset, endOffset, easing, stops, windowStart, windowEnd} = this;
        return new TrackClip(startOffset, endOffset, easing, stops.map(({offset, value}) => ({offset, value: transform(value)})), windowStart, windowEnd);
    }
}

/** A stretch of a track and the clips in it: when it starts after the outermost definition starts, how long it lasts, and its clips, one after another without gaps, their offsets fractions of it. */
export interface TrackRunPart<Value> {
    start: Seconds;
    duration: Seconds;
    clips: readonly TrackClip<Value>[];
}

/**
 * One property's run on one target: its clips, one iteration of it, repeated as its timing says,
 * and whether it holds its value before it starts and after it ends.
 */
export class TrackRun<Value> {
    /** `clips` are one after another without gaps, their offsets fractions of its iteration. Throws without clips. */
    constructor(
        readonly name: string | undefined,
        readonly timing: TrackEntry,
        readonly clips: readonly TrackClip<Value>[],
        /** Whether it holds the value it starts on before it starts. */
        readonly holdsBefore: boolean,
        /** Whether it holds the value it ends on once it's done. */
        readonly holdsAfter: boolean
    ) {
        if (!clips.length)
            throw new Error("A track run has at least one clip, but it was given none. Give it the clips of its iteration.");
    }

    /** Its iterations from `first` to `last`, as `partOf` lays them out. */
    part(first: number, last: number, options: { holdsUntilNext?: boolean } = {}): TrackRunPart<Value | InterpolationToken<Value>> {
        return partOf(this.timing, this.clips, first, last, options);
    }
}

/**
 * A run's iterations from `first` to `last`, one after another, each one's end value held until the next starts, as a part from where its first clip starts
 * to where its last one ends, 0 to 1; with `holdsUntilNext`, the last one's is held too, until the iteration after it would start. `clips` are one iteration.
 * A part without duration keeps its clips' offsets in their iteration.
 * Every other iteration of an oscillation is laid out back to front, each clip flipped (`TrackClip.flip`).
 * Throws without clips, or for iterations the run doesn't have.
 */
export function partOf<Value>(
    timing: TrackEntry,
    clips: readonly TrackClip<Value>[],
    first: number,
    last: number,
    {holdsUntilNext = false}: { holdsUntilNext?: boolean } = {}
): TrackRunPart<Value | InterpolationToken<Value>> {
    const {repeatCount} = timing;
    if (!clips.length)
        throw new Error("A run's iterations are laid out from its clips, but it was given none. Give it the clips of its iteration.");
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || first > last || last > repeatCount)
        throw new Error(`A run's iterations are 0 to its repeat count, ${repeatCount}, but iterations ${first} to ${last} were asked for. Ask for whole iterations within that range, the first one no later than the last.`);

    const iterations = Array.from({length: last - first + 1}, (_, index) => iterationAt(timing, clips, first + index));
    const firstIteration = iterations[0]!;
    const lastIteration = iterations.at(-1)!;
    const next = holdsUntilNext ? iterationAt(timing, clips, last + 1) : undefined;
    const start = timeAt(firstIteration, firstIteration.clips[0]!.startOffset);
    const end = next ? timeAt(next, next.clips[0]!.startOffset) : timeAt(lastIteration, lastIteration.clips.at(-1)!.endOffset);
    const duration = end - start;
    if (duration === 0) return {start, duration, clips: firstIteration.clips};

    const placed = iterations.map(iteration => moveClips(iteration, start, duration));
    const lastClip = placed.at(-1)!.at(-1)!;
    return {start, duration, clips: [...joinClips(placed), ...(next ? holdClips(lastClip.endValue, lastClip.endOffset, 1) : [])]};
}

/** The part's clips moved into the time that starts at `start` and lasts `duration`, their offsets fractions of it; it must have duration. */
export function moveClips<Value>(part: TrackRunPart<Value>, start: Seconds, duration: Seconds): TrackClip<Value>[] {
    const offsetOf = (offset: number) => (timeAt(part, offset) - start) / duration;
    return part.clips.map(clip => clip.move(offsetOf(clip.startOffset), offsetOf(clip.endOffset)));
}

/** Groups of clips placed in the same time, one after another, each one's end value held until the next starts. */
export function joinClips<Value>(groups: readonly (readonly TrackClip<Value>[])[]): TrackClip<Value | InterpolationToken<Value>>[] {
    return groups.flatMap((clips, index): TrackClip<Value | InterpolationToken<Value>>[] => {
        const previous = groups[index - 1]?.at(-1);
        return previous ? [...holdClips(previous.endValue, previous.endOffset, clips[0]!.startOffset), ...clips] : [...clips];
    });
}

/** The iteration at `index`, as a part: back to front, each clip flipped, every other one of an oscillation. */
function iterationAt<Value>({start, duration, repeatDelay, oscillate}: TrackEntry, clips: readonly TrackClip<Value>[], index: number): TrackRunPart<Value> {
    const iterationClips = index % 2 === 0 || !oscillate ? clips : clips.map(clip => clip.flip(oscillate)).reverse();
    return {start: start + index * (duration + repeatDelay), duration, clips: iterationClips};
}

/** The time at `offset` of the part, after the outermost definition starts. */
function timeAt({start, duration}: TrackRunPart<unknown>, offset: number): Seconds {
    return start + offset * duration;
}

/** A clip holding `value` from `start` to `end`, when there's time to hold it. */
function holdClips<Value>(value: Value, start: number, end: number): TrackClip<Value>[] {
    return end > start ? [new TrackClip(start, end, linear, [{offset: 0, value}, {offset: 1, value}])] : [];
}
