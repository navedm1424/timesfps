import type {Easing} from "../easing.ts";
import {linear} from "../easing-specifier.ts";
import type {Progress, Seconds} from "../types.ts";
import type {RepeatOptions} from "../playback-options.ts";
import {partitionPoint} from "../utils/collections.ts";
import {clamp, invLerp} from "../utils/math.ts";
import {type InterpolatedValueToken, interpolatedValueOf} from "./track-values.ts";

export interface TrackStop<Value> {
    offset: Progress;
    value: Value;
}

/** A span's values at offsets of its progress, in order: between two stops, the value runs linearly with the progress, and past the outer ones, it continues the nearest two. */
export class TrackStops<Value> {
    constructor(readonly stops: readonly TrackStop<Value>[]) {}

    /** The value throughout. */
    static constant<Value>(value: Value): TrackStops<Value> {
        return new TrackStops([{offset: 0, value}, {offset: 1, value}]);
    }

    /** The stop's own value at a stop; otherwise the value between the stops around the progress, or between the nearest two past either end. */
    valueAt(progress: Progress): Value | InterpolatedValueToken<Value> {
        const {stops} = this;
        const atOrAfterIndex = partitionPoint(stops, stop => stop.offset >= progress);
        const stopThere = stops[atOrAfterIndex];
        if (stopThere?.offset === progress) return stopThere.value;
        if (stops.length === 1) return stops[0]!.value;

        const endIndex = clamp(atOrAfterIndex, 1, stops.length - 1);
        const start = stops[endIndex - 1]!;
        const end = stops[endIndex]!;
        return interpolatedValueOf(start.value, end.value, invLerp(start.offset, end.offset, progress));
    }

    /** The stops strictly between the two progresses, in either order. */
    stopsBetween(fromProgress: Progress, toProgress: Progress): TrackStop<Value>[] {
        const lowest = Math.min(fromProgress, toProgress);
        const highest = Math.max(fromProgress, toProgress);
        return this.stops.filter(({offset}) => offset > lowest && offset < highest);
    }

    /** The stops between the lowest and the highest of the progresses, with a stop of the value there at each of the progresses that has none; offsets stay as they are. */
    narrowedTo(progresses: readonly Progress[]): TrackStops<Value | InterpolatedValueToken<Value>> {
        const reached = this.stopsBetween(Math.min(...progresses), Math.max(...progresses)).map(({offset}) => offset);
        const offsets = [...new Set([...reached, ...progresses])].sort((first, second) => first - second);
        return new TrackStops(offsets.map(offset => ({offset, value: this.valueAt(offset)})));
    }

    /** The same values played backwards: each moves from its offset to 1 minus it. */
    reverse(): TrackStops<Value> {
        return new TrackStops(this.stops.map(({offset, value}) => ({offset: 1 - offset, value})).reverse());
    }

    map<Other>(transform: (value: Value, offset: Progress) => Other): TrackStops<Other> {
        return new TrackStops(this.stops.map(({offset, value}) => ({offset, value: transform(value, offset)})));
    }
}

/** A stretch of a track whose value follows the stops through the easing. */
export interface TrackSpan<Value> {
    start: Seconds;
    end: Seconds;
    easing: Easing;
    stops: TrackStops<Value>;
}

/** The value at the progress the span's easing starts from. */
export function startValueOf<Value>({easing, stops}: TrackSpan<Value>): Value | InterpolatedValueToken<Value> {
    return stops.valueAt(easing.startProgress);
}

/** The value at the progress the span's easing ends at. */
export function endValueOf<Value>({easing, stops}: TrackSpan<Value>): Value | InterpolatedValueToken<Value> {
    return stops.valueAt(easing.endProgress);
}

/** Spans laid out one after another, without gaps. */
export class TrackRun<Value> {
    constructor(readonly spans: readonly TrackSpan<Value>[]) {}

    static play<Value>(duration: Seconds, easing: Easing, stops: TrackStops<Value>): TrackRun<Value> {
        return new TrackRun([{start: 0, end: duration, easing, stops}]);
    }

    /** The runs one after another, each one's end value held until the next starts. */
    static joined<Value>(runs: readonly TrackRun<Value>[]): TrackRun<Value | InterpolatedValueToken<Value>> {
        return new TrackRun(runs.flatMap((run, index): TrackSpan<Value | InterpolatedValueToken<Value>>[] => {
            const previous = runs[index - 1];
            return previous ? [...holdSpans(previous.endValue, previous.end, run.start), ...run.spans] : [...run.spans];
        }));
    }

    get start(): Seconds {
        return this.spans[0]!.start;
    }

    get end(): Seconds {
        return this.spans.at(-1)!.end;
    }

    get startValue(): Value | InterpolatedValueToken<Value> {
        return startValueOf(this.spans[0]!);
    }

    get endValue(): Value | InterpolatedValueToken<Value> {
        return endValueOf(this.spans.at(-1)!);
    }

    /** The value at `time`, which is the next span's start where two meet. */
    valueAt(time: Seconds): Value | InterpolatedValueToken<Value> {
        const {stops, progress} = this.progressAt(time);
        return stops.valueAt(progress);
    }

    private progressAt(time: Seconds): { stops: TrackStops<Value>; progress: Progress } {
        const span = this.spans.findLast(span => span.start <= time) ?? this.spans[0]!;
        const {start, end, easing, stops} = span;
        if (time >= end) return {stops, progress: easing.endProgress};
        if (time <= start) return {stops, progress: easing.startProgress};
        return {stops, progress: easing.progressAt((time - start) / (end - start))};
    }

    /** The same run with each value transformed. */
    map<Other>(transform: (value: Value) => Other): TrackRun<Other> {
        return new TrackRun(this.spans.map(span => ({...span, stops: span.stops.map(value => transform(value))})));
    }

    shifted(by: Seconds): TrackRun<Value> {
        return new TrackRun(this.spans.map(span => ({...span, start: span.start + by, end: span.end + by})));
    }

    /**
     * The part of the run from `start` to `end`. A span cut through its easing keeps the stops its cut easing reaches, where they are,
     * with a stop at each progress the cut easing starts, turns and ends at that has none: the value there.
     * A span without duration stays from `start` up to, but not at, `end`.
     */
    cut(start: Seconds, end: Seconds): TrackRun<Value | InterpolatedValueToken<Value>> {
        return new TrackRun(this.spans.flatMap((span): TrackSpan<Value | InterpolatedValueToken<Value>>[] => {
            if (span.end === span.start) return span.start >= start && span.start < end ? [span] : [];
            const cutStart = Math.max(span.start, start);
            const cutEnd = Math.min(span.end, end);
            if (cutEnd <= cutStart) return [];
            if (cutStart === span.start && cutEnd === span.end) return [span];

            const offsetOf = (time: Seconds) => (time - span.start) / (span.end - span.start);
            const easing = span.easing.segment(offsetOf(cutStart), offsetOf(cutEnd));
            return [{start: cutStart, end: cutEnd, easing, stops: span.stops.narrowedTo(reachedProgressesOf(easing))}];
        }));
    }

    /** The run with `top` in place of its own spans for as long as `top` lasts. */
    overlaid(top: TrackRun<Value>): TrackRun<Value | InterpolatedValueToken<Value>> {
        return new TrackRun([...this.cut(this.start, top.start).spans, ...top.spans, ...this.cut(top.end, this.end).spans]);
    }

    heldUntil(time: Seconds): TrackRun<Value | InterpolatedValueToken<Value>> {
        return new TrackRun([...this.spans, ...holdSpans(this.endValue, this.end, time)]);
    }

    /**
     * The run in the iteration at `index` of a repeat whose iterations last `iterationDuration`, each starting after the previous one and the repeat delay.
     * Every other iteration of a reverse or a mirror flips in time: a reverse runs the easing backwards, a mirror keeps it running forwards through flipped stops.
     */
    iteration(index: number, iterationDuration: Seconds, {repeatDelay = 0, repeatMode = 'loop'}: RepeatOptions): TrackRun<Value> {
        const iterationStart = index * (iterationDuration + repeatDelay);
        if (index % 2 === 0 || repeatMode === 'loop') return this.shifted(iterationStart);

        const flipped = this.spans.map(({start, end, easing, stops}): TrackSpan<Value> => ({
            start: iterationDuration - end,
            end: iterationDuration - start,
            easing: repeatMode === 'reverse' ? easing.reverse() : easing,
            stops: repeatMode === 'reverse' ? stops : stops.reverse()
        }));
        return new TrackRun(flipped.reverse()).shifted(iterationStart);
    }
}

function holdSpans<Value>(value: Value, start: Seconds, end: Seconds): TrackSpan<Value>[] {
    return end > start ? [{start, end, easing: linear, stops: TrackStops.constant(value)}] : [];
}

/** The progresses the easing's window starts at, turns at and ends at. */
function reachedProgressesOf(easing: Easing): Progress[] {
    return [easing.startProgress, ...easing.turningOffsets().map(offset => easing.progressAt(offset)), easing.endProgress];
}
