import type {CSSValue} from "../dom/mapping.ts";
import type {Easing} from "../easing.ts";
import type {RepeatDescriptor} from "../playback-options.ts";
import type {Progress, Seconds} from "../types.ts";
import {lerp} from "../utils/math.ts";

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

/** A value at an offset of an easing's progress: a given one, or `null` for the value underneath, left for the stage that plays the track to give. */
export interface TrackStop {
    offset: Progress;
    value: CSSValue | null;
}

/** What an animation leaf plays on one property of one target: its run through its stops, by its easing. */
export interface TrackItem extends TrackEntry {
    type: 'item';
    name: string | undefined;
    /** When its last iteration ends; `Infinity` when it never ends. */
    end: Seconds;
    easing: Easing;
    /** Its values at offsets of its easing's progress, in order. */
    stops: readonly TrackStop[];
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
    /** When its entries end in its last iteration; `Infinity` when it never ends. */
    end: Seconds;
    /** In the order they show over each other in, none of them holding before it starts. */
    entries: readonly (TrackItem | TrackGroup)[];
    /** Whether it holds the value it starts on before it starts. */
    holdsBefore: boolean;
    /** Whether it holds the value it ends on once it's done. */
    holdsAfter: boolean;
}

/** The time `offset` of the way from the item's start to its end: its start at 0, and its end at 1. */
export function timeAtOffset({start, end}: TrackItem, offset: number): Seconds {
    // `lerp` would give NaN at 0 for an item that never ends.
    return offset === 0 ? start : lerp(start, end, offset);
}
