import type {Easing} from "../easing.ts";
import type {RepeatDescriptor} from "../plan.ts";
import type {Progress, Seconds} from "../types.ts";
import {partitionPoint} from "../utils/collections.ts";
import {clamp, invLerp} from "../utils/math.ts";
import {type InterpolationToken, type TrackValue, valueBetween} from "./track-values.ts";

/** When a run starts, how long each of its iterations lasts, and how it repeats; one without duration doesn't repeat. */
export interface TrackEntry extends RepeatDescriptor {
    /** After the outermost definition starts. */
    start: Seconds;
    iterationDuration: Seconds;
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
 * The value of stops, in order, at `progress`: the stop's own value at a stop; otherwise the value between the stops around it,
 * which runs linearly with the progress, or between the nearest two past either end.
 */
export function valueAtProgress<Value>(stops: readonly TrackStop<Value>[], progress: Progress): Value | InterpolationToken<Value> {
    const atOrAfterIndex = partitionPoint(stops, stop => stop.offset >= progress);
    const stopThere = stops[atOrAfterIndex];
    if (stopThere?.offset === progress) return stopThere.value;
    if (stops.length === 1) return stops[0]!.value;

    const endIndex = clamp(atOrAfterIndex, 1, stops.length - 1);
    const start = stops[endIndex - 1]!;
    const end = stops[endIndex]!;
    return valueBetween(start.value, end.value, invLerp(start.offset, end.offset, progress));
}

/** What an animation leaf plays on one property of one target: its run through its stops, by its easing. */
export interface TrackItem extends TrackEntry {
    type: 'item';
    name: string | undefined;
    easing: Easing;
    /** Its values at offsets of its easing's progress, in order, as `valueAtProgress` reads them. */
    stops: readonly TrackStop<TrackValue>[];
    /** Whether it holds the value it starts on before it starts. */
    holdsBefore: boolean;
    /** Whether it holds the value it ends on once it's done. */
    holdsAfter: boolean;
}

/**
 * A repeating sequence's part of one property of one target: its run, and the entries in it as they play in its first iteration.
 * Every iteration plays them, and every other one of an oscillation flips them.
 */
export interface TrackGroup extends TrackEntry {
    type: 'group';
    name: string | undefined;
    /** In the order they show over each other in, none of them holding before it starts. */
    entries: readonly (TrackItem | TrackGroup)[];
    /** Whether it holds the value it starts on before it starts. */
    holdsBefore: boolean;
    /** Whether it holds the value it ends on once it's done. */
    holdsAfter: boolean;
}
