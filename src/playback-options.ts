import type {StaggerOrigin} from "./stagger.ts";
import type {Seconds} from "./types.ts";
import {checkNumber} from "./utils/validation.ts";

/** The delay of each element, from its index among total; what delay takes, and what stagger() makes, which also keeps its origin. */
export interface Stagger {
    (index: number, total: number): Seconds;
    readonly from?: StaggerOrigin;
}
export type RepeatMode = 'loop' | 'reverse' | 'mirror';

export interface RepeatOptions {
    repeat?: number;
    repeatDelay?: Seconds;
    repeatMode?: RepeatMode;
}

/** The options of a timing: a delay before the first play, and how it repeats. */
export interface PlaybackOptions extends RepeatOptions {
    delay?: Seconds | Stagger;
}

/**
 * What every other iteration of an oscillating repeat flips: its time, so it plays backwards,
 * or its values, so it runs from the end values to the start ones with its easing forwards.
 */
export type Oscillation = 'time' | 'values';

/**
 * How a timing repeats after its first iteration: its repeat options as plays read them.
 * One without duration doesn't repeat.
 */
export interface RepeatDescriptor {
    /** How many iterations follow its first; `Infinity` repeats forever. */
    repeatCount: number;
    /** How long it holds the value it ends on before each repeat. */
    repeatDelay: Seconds;
    /** Without it, every repeat starts over. */
    oscillate?: Oscillation;
}

const repeatModes: readonly RepeatMode[] = ['loop', 'reverse', 'mirror'];

/** Delays and repeat delays must be finite, the repeat count a number, and the repeat mode a known one; `label` names the timing in messages. */
export function checkPlaybackOptions(options: PlaybackOptions, label: string): void {
    checkDelay(options.delay, label);
    checkRepeatOptions(options, label);
}

/** A number delay must be finite; a stagger's delays are checked as it gives them (`checkedStaggerOf`). `label` names the timing in messages. */
export function checkDelay(delay: Seconds | Stagger | undefined, label: string): void {
    if (typeof delay === 'number') checkNumber(delay, `${label}'s delay`);
}

/** The repeat delay must be finite, the repeat count a number, and the repeat mode a known one; `label` names the timing in messages. */
export function checkRepeatOptions(options: RepeatOptions, label: string): void {
    checkNumber(options.repeatDelay, `${label}'s repeat delay`);
    checkNumber(options.repeat, `${label}'s repeat count`, {allowInfinity: true});
    if (options.repeatMode !== undefined && !repeatModes.includes(options.repeatMode))
        throw new TypeError(`${label} repeats as "${options.repeatMode}", which isn't one of ${repeatModes.map(repeatMode => `"${repeatMode}"`).join(', ')}.`);
}

/** Negative repeat counts and delays become 0, and fractional counts round down. */
export function clampedRepeats<Options extends RepeatOptions>(options: Options): Options {
    const {repeat, repeatDelay} = options;
    return {
        ...options,
        ...(repeat !== undefined && {repeat: Math.max(0, Math.floor(repeat))}),
        ...(repeatDelay !== undefined && {repeatDelay: Math.max(0, repeatDelay)})
    };
}

/** A negative delay becomes 0. */
export function clampedDelay<Options extends { delay?: Seconds | Stagger }>(options: Options): Options {
    return typeof options.delay === 'number' ? {...options, delay: Math.max(0, options.delay)} : options;
}

/** Wraps a stagger so NaN and infinite delays throw, and negative ones become 0; it keeps the stagger's origin. */
export function checkedStaggerOf(stagger: Stagger): Stagger {
    const checked = (index: number, total: number) => Math.max(0, checkNumber(stagger(index, total), `The staggered delay of element ${index}`));
    return stagger.from === undefined ? checked : Object.assign(checked, {from: stagger.from});
}

/** The delay a timing keeps: 0 without one, a negative one 0, and a stagger checked by `checkedStaggerOf`. */
export function resolveDelay(delay: Seconds | Stagger = 0): Seconds | Stagger {
    return typeof delay === 'number' ? Math.max(0, delay) : checkedStaggerOf(delay);
}

/** How a timing whose iterations last `iterationDuration` repeats, as its clamped `options` say; one without duration or repeats doesn't repeat at all. */
export function repeatDescriptorOf(iterationDuration: Seconds, options: RepeatOptions): RepeatDescriptor {
    const {repeat = 0, repeatDelay = 0, repeatMode = 'loop'} = clampedRepeats(options);
    if (iterationDuration === 0 || repeat === 0) return {repeatCount: 0, repeatDelay: 0};
    const oscillate: Oscillation | undefined = repeatMode === 'reverse' ? 'time' : repeatMode === 'mirror' ? 'values' : undefined;
    return {repeatCount: repeat, repeatDelay, ...(oscillate && {oscillate})};
}
