import type {Easing} from "../easing.ts";
import {linear} from "../easing-specifier.ts";
import type {Progress, Seconds} from "../types.ts";
import type {CSSValue} from "../dom/mapping.ts";
import type {RepeatOptions} from "../playback-options.ts";
import {TweenStops} from "../tween-stops.ts";
import type {NumericStops} from "./stops.ts";

/** A stretch of a track whose value follows the stops through the easing. */
export interface TrackSpan {
    start: Seconds;
    end: Seconds;
    easing: Easing;
    stops: TweenStops;
}

/** Spans laid out one after another, without gaps. */
export class TrackRun {
    constructor(readonly spans: readonly TrackSpan[]) {}

    static play(duration: Seconds, easing: Easing, stops: TweenStops): TrackRun {
        return new TrackRun([{start: 0, end: duration, easing, stops}]);
    }

    /** The runs one after another, each one's end value held until the next starts. */
    static joined(runs: readonly TrackRun[]): TrackRun {
        return new TrackRun(runs.flatMap((run, index) => {
            const previous = runs[index - 1];
            return previous ? [...holdSpans(previous.endValue, previous.end, run.start), ...run.spans] : run.spans;
        }));
    }

    get start(): Seconds {
        return this.spans[0]!.start;
    }

    get end(): Seconds {
        return this.spans.at(-1)!.end;
    }

    /** The value of the stop the run ends on, which is the end of its last span's easing window. */
    get endValue(): CSSValue | null {
        const {easing, stops} = this.spans.at(-1)!;
        const value = stops.get(easing.windowEnd);
        if (value === undefined) throw new Error(`There's no stop at ${easing.windowEnd}.`);
        return value;
    }

    /** The value at `time`, which is the next span's start where two meet, with each span's stops as numbers. */
    valueAt(time: Seconds, numericStopsOf: (stops: TweenStops) => NumericStops): number {
        const {stops, progress} = this.progressAt(time);
        return numericStopsOf(stops).valueAt(progress);
    }

    /** The value at `time` when it's exactly a stop's, as it is at a whole span's ends and through a hold. */
    stopValueAt(time: Seconds): CSSValue | null | undefined {
        const {stops, progress} = this.progressAt(time);
        const [value, ...otherValues] = new Set(stops.stops.map(({value}) => value));
        return otherValues.length === 0 ? value : stops.get(progress);
    }

    private progressAt(time: Seconds): { stops: TweenStops; progress: Progress } {
        const span = [...this.spans].reverse().find(span => span.start <= time) ?? this.spans[0]!;
        const {start, end, easing, stops} = span;
        if (time >= end) return {stops, progress: easing.endProgress};
        if (time <= start) return {stops, progress: easing.startProgress};
        return {stops, progress: easing.progressAt((time - start) / (end - start))};
    }

    shifted(by: Seconds): TrackRun {
        return new TrackRun(this.spans.map(span => ({...span, start: span.start + by, end: span.end + by})));
    }

    heldUntil(time: Seconds): TrackRun {
        return new TrackRun([...this.spans, ...holdSpans(this.endValue, this.end, time)]);
    }

    /**
     * The run in the iteration at `index` of a repeat whose iterations last `iterationDuration`, each starting after the previous one and the repeat delay.
     * Every other iteration of a reverse or a mirror flips in time: a reverse runs the easing backwards, a mirror keeps it running forwards through flipped stops.
     */
    iteration(index: number, iterationDuration: Seconds, {repeatDelay = 0, repeatMode = 'loop'}: RepeatOptions): TrackRun {
        const iterationStart = index * (iterationDuration + repeatDelay);
        if (index % 2 === 0 || repeatMode === 'loop') return this.shifted(iterationStart);

        const flipped = this.spans.map(({start, end, easing, stops}): TrackSpan => ({
            start: iterationDuration - end,
            end: iterationDuration - start,
            easing: repeatMode === 'reverse' ? easing.reversed() : easing,
            stops: repeatMode === 'reverse' ? stops : stops.reverse()
        }));
        return new TrackRun(flipped.reverse()).shifted(iterationStart);
    }
}

function holdSpans(value: CSSValue | null, start: Seconds, end: Seconds): TrackSpan[] {
    return end > start ? [{start, end, easing: linear, stops: TweenStops.constant(value)}] : [];
}
