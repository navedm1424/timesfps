import type {Seconds} from "../types.ts";
import type {KeyedRamp} from "./keyed-ramps.ts";
import type {TrackValue} from "./track-values.ts";

/** Holds the value at the end it's on, forever. */
export interface HoldExtrapolation {
    type: 'hold';
}

/** Lengths are fractions of the entry's duration. */
interface RepeatExtrapolation {
    /** How many more times it plays after its first play; `Infinity` repeats forever. */
    iterations: number;
    /** How long it holds before each repeat. */
    pause: number;
    /** Whether it holds the value it ends on once it's done. */
    holdsAfter: boolean;
}

export interface LoopExtrapolation extends RepeatExtrapolation {
    type: 'loop';
}

/** Every other play flips: in time, so it plays backwards, or in values, so it runs from the end values to the start ones with its easing forwards. */
export interface OscillateExtrapolation extends RepeatExtrapolation {
    type: 'oscillate';
    flip: 'time' | 'values';
}

export type Extrapolation = HoldExtrapolation | LoopExtrapolation | OscillateExtrapolation;

/** A range on a track: its keyed ramp, within 0 to `duration`, `start` after the outermost definition starts, and what it shows before and after it. */
export interface TrackEntry {
    name: string | undefined;
    start: Seconds;
    duration: Seconds;
    keyedRamp: KeyedRamp<TrackValue>;
    preExtrapolation?: HoldExtrapolation;
    postExtrapolation?: Extrapolation;
}
