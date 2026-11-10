import type {Easing} from "../easing.ts";
import {linear} from "../easing-specifier.ts";
import type {Progress, Seconds} from "../types.ts";
import {partitionPoint} from "../utils/collections.ts";
import {clamp, invLerp} from "../utils/math.ts";
import {type InterpolationToken, valueBetween} from "./track-values.ts";

/**
 * What every other iteration of an oscillating repeat flips: its time, so it plays backwards,
 * or its values, so it runs from the end values to the start ones with its easing forwards.
 */
export type Oscillation = 'time' | 'values';

/** When a run starts, how long each of its iterations lasts, and how it repeats; one without duration doesn't repeat. */
export interface TrackRunTiming {
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
export function repeats({repeatCount}: TrackRunTiming): boolean {
    return repeatCount > 0;
}

/** Whether it repeats forever; one without duration never does. */
export function repeatsForever({repeatCount}: TrackRunTiming): boolean {
    return repeatCount === Infinity;
}

export interface TrackStop<Value> {
    offset: Progress;
    value: Value;
}

/** A stretch of a run whose value follows its stops through its easing. */
export class TrackRunSpan<Value> {
    constructor(
        readonly start: Seconds,
        readonly end: Seconds,
        readonly easing: Easing,
        /** Its values at offsets of its progress, in order: between two stops, the value runs linearly with the progress, and past the outer ones, it continues the nearest two. */
        readonly stops: readonly TrackStop<Value>[]
    ) {}

    /** The value at the progress its easing starts from. */
    get startValue(): Value | InterpolationToken<Value> {
        return this.valueAtProgress(this.easing.startProgress);
    }

    /** The value at the progress its easing ends at. */
    get endValue(): Value | InterpolationToken<Value> {
        return this.valueAtProgress(this.easing.endProgress);
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

    /** The same span, moved in time. */
    shift(by: Seconds): TrackRunSpan<Value> {
        return new TrackRunSpan(this.start + by, this.end + by, this.easing, this.stops);
    }

    /** The same span with each value transformed. */
    map<Other>(transform: (value: Value) => Other): TrackRunSpan<Other> {
        return new TrackRunSpan(this.start, this.end, this.easing, this.stops.map(({offset, value}) => ({offset, value: transform(value)})));
    }
}

/**
 * One property's run on one target: its spans, one iteration of it, repeated as its timing says,
 * and whether it holds its value before it starts and after it ends.
 */
export class TrackRun<Value> {
    /** `spans` are one after another without gaps, from the timing's start. Throws without spans. */
    constructor(
        readonly name: string | undefined,
        readonly timing: TrackRunTiming,
        readonly spans: readonly TrackRunSpan<Value>[],
        /** Whether it holds the value it starts on before it starts. */
        readonly holdsBefore: boolean,
        /** Whether it holds the value it ends on once it's done. */
        readonly holdsAfter: boolean
    ) {
        if (!spans.length)
            throw new Error("A track run has at least one span, but it was given none. Give it the spans of its iteration.");
    }

    /** Its iterations from `first` to `last`, as `iterationSpansOf` lays them out. */
    iterationSpans(first: number, last: number, options: { holdsUntilNext?: boolean } = {}): TrackRunSpan<Value | InterpolationToken<Value>>[] {
        return iterationSpansOf(this.timing, this.spans, first, last, options);
    }
}

/**
 * The spans of a run's iterations from `first` to `last`, after the outermost definition starts, one after another, each one's end value held until the next starts;
 * with `holdsUntilNext`, the last one's too, until the iteration after it would start. `spans` are one iteration, from the timing's start.
 * Every other iteration of an oscillation is laid out back to front: one that flips its time runs each easing backwards, and one that flips its values runs it forwards through reversed stops.
 * Throws without spans, or for iterations the run doesn't have.
 */
export function iterationSpansOf<Value>(
    timing: TrackRunTiming,
    spans: readonly TrackRunSpan<Value>[],
    first: number,
    last: number,
    {holdsUntilNext = false}: { holdsUntilNext?: boolean } = {}
): TrackRunSpan<Value | InterpolationToken<Value>>[] {
    const {repeatCount} = timing;
    if (!spans.length)
        throw new Error("A run's iterations are laid out from its spans, but it was given none. Give it the spans of its iteration.");
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || first > last || last > repeatCount)
        throw new Error(`A run's iterations are 0 to its repeat count, ${repeatCount}, but iterations ${first} to ${last} were asked for. Ask for whole iterations within that range, the first one no later than the last.`);

    const iterations = Array.from({length: last - first + 1}, (_, index) => iterationAt(timing, spans, first + index));
    if (!holdsUntilNext) return joinSpans(iterations);

    const lastSpan = iterations.at(-1)!.at(-1)!;
    return [...joinSpans(iterations), ...holdSpans(lastSpan.endValue, lastSpan.end, iterationAt(timing, spans, last + 1)[0]!.start)];
}

/** Groups of spans one after another, each one's end value held until the next starts. */
export function joinSpans<Value>(groups: readonly (readonly TrackRunSpan<Value>[])[]): TrackRunSpan<Value | InterpolationToken<Value>>[] {
    return groups.flatMap((spans, index): TrackRunSpan<Value | InterpolationToken<Value>>[] => {
        const previous = groups[index - 1]?.at(-1);
        return previous ? [...holdSpans(previous.endValue, previous.end, spans[0]!.start), ...spans] : [...spans];
    });
}

/** The spans of one iteration in the iteration at `index`, after the outermost definition starts. */
function iterationAt<Value>({start, duration, repeatDelay, oscillate}: TrackRunTiming, spans: readonly TrackRunSpan<Value>[], index: number): TrackRunSpan<Value>[] {
    const iteration = index % 2 === 0 || !oscillate ? spans : flipSpans(spans, duration, oscillate);
    return iteration.map(span => span.shift(start + index * (duration + repeatDelay)));
}

/**
 * The spans within 0 to `duration` laid out back to front: flipping their time runs each easing backwards,
 * and flipping their values keeps it running forwards through reversed stops, each one moved from its offset to 1 minus it.
 */
function flipSpans<Value>(spans: readonly TrackRunSpan<Value>[], duration: Seconds, oscillate: Oscillation): TrackRunSpan<Value>[] {
    return spans.map(({start, end, easing, stops}) => new TrackRunSpan(
        duration - end,
        duration - start,
        oscillate === 'time' ? easing.reverse() : easing,
        oscillate === 'time' ? stops : stops.map(({offset, value}) => ({offset: 1 - offset, value})).reverse()
    )).reverse();
}

/** A span holding `value` from `start` to `end`, when there's time to hold it. */
function holdSpans<Value>(value: Value, start: Seconds, end: Seconds): TrackRunSpan<Value>[] {
    return end > start ? [new TrackRunSpan(start, end, linear, [{offset: 0, value}, {offset: 1, value}])] : [];
}
