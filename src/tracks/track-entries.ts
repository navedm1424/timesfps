import type {Seconds} from "../types.ts";
import type {KeyedRamp, Oscillation} from "./keyed-ramps.ts";
import type {TrackValue} from "./track-values.ts";

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

/** One layered or merged entry on a track: a run, with its keyed ramp within 0 to `duration`, and whether it holds its value before it starts and after it ends. */
export interface TrackEntry extends TrackRunTiming {
    name: string | undefined;
    keyedRamp: KeyedRamp<TrackValue>;
    /** Whether it holds the value it starts on before it starts. */
    holdsBefore: boolean;
    /** Whether it holds the value it ends on once it's done. */
    holdsAfter: boolean;
}
