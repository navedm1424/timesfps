import {
    checkPlaybackOptions,
    clampedDelay,
    clampedRepeats,
    type PlaybackDescriptor,
    playbackDescriptorOf,
    type PlaybackOptions,
    type RepeatOptions
} from "./playback-options.ts";
import {checkTransitionOptions, isTransitionKey, type TransitionOptions} from "./transition.ts";
import type {Seconds} from "./types.ts";
import {checkNumber} from "./utils/validation.ts";

/** A transition with the options of its timing spread into it. */
export type AnimationTimingOptions = TransitionOptions & PlaybackOptions;

/** One run through the transition, with its delay and repeats. */
export class AnimationTiming {
    readonly playback: PlaybackDescriptor;

    private constructor(readonly transition: TransitionOptions, options: PlaybackOptions = {}) {
        checkPlaybackOptions(options, "The timing");
        checkTransitionOptions(transition, "The timing's transition");
        this.playback = playbackDescriptorOf(options);
    }

    /** A descriptor is split by key into its transition and its options. */
    static of(timing: AnimationTimingOptions): AnimationTiming;
    static of(transition: TransitionOptions, options?: PlaybackOptions): AnimationTiming;
    // static of<T extends string[]>(tweens: { [I in keyof T]: TimedTween<T[I]>; }, options?: PlaybackOptions): TimedTweenTiming<T>;
    // static of<T extends string[]>(transition: TransitionOptions, tweens: { [I in keyof T]: RatioTween<T[I]>; }, options?: PlaybackOptions): SelfTimedTiming<T>;
    static of(transition: TransitionOptions | AnimationTimingOptions, options?: PlaybackOptions): AnimationTiming {
        const entries = Object.entries(transition).filter(([, value]) => value !== undefined);
        const transitionOptions = Object.fromEntries(entries.filter(([key]) => isTransitionKey(key))) as TransitionOptions;
        const playbackOptions = Object.fromEntries(entries.filter(([key]) => !isTransitionKey(key))) as PlaybackOptions;
        return new AnimationTiming(transitionOptions, {...playbackOptions, ...options});
    }
}

/**
 * `repeat` must be finite.
 * @internal
 */
interface TimedTween<Name extends string = string> extends RepeatOptions {
    name: Name;
    transition: TransitionOptions;
    delay?: Seconds;
}

// export interface RatioTween<Name extends string = string> {
//     name: Name;
//     ratio?: Ratio;             // omitted = equal share of what's left
//     transition?: StretchableTransition;
// }

// export class SelfTimedTiming<T extends string[]> {
//     readonly type = "self-timed" as const;
//     constructor(
//         readonly transition: TransitionOptions,
//         readonly tweens: {
//             readonly [I in keyof T]: RatioTween<T[I]>;
//         },
//         options?: PlaybackOptions
//     ) {}
// }

/** @internal */
class TimedTweenTiming<T extends string[]> {
    readonly type = "timed-tween" as const;
    readonly options: PlaybackOptions;
    readonly tweens: { readonly [I in keyof T]: TimedTween<T[I]>; };

    constructor(tweens: { readonly [I in keyof T]: TimedTween<T[I]>; }, options: PlaybackOptions = {}) {
        checkPlaybackOptions(options, "The timing");
        this.options = clampedDelay(clampedRepeats(options));
        const givenTweens: readonly TimedTween[] = tweens;
        for (const tween of givenTweens) {
            checkNumber(tween.repeat, `Tween "${tween.name}"'s repeat count`);
            checkNumber(tween.delay, `Tween "${tween.name}"'s delay`);
            checkNumber(tween.repeatDelay, `Tween "${tween.name}"'s repeat delay`);
            checkTransitionOptions(tween.transition, `Tween "${tween.name}"'s transition`);
        }
        this.tweens = givenTweens.map(tween => clampedDelay(clampedRepeats(tween))) as unknown as typeof this.tweens;
    }
    // easing?: EasingDescriptor;           // compounds with each tween's easing
}
