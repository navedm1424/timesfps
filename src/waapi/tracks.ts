import type {RepeatOptions} from "../playback-options.ts";
import {TrackRun} from "../resolution/track-runs.ts";
import type {TrackEntry, Tracks} from "../resolution/tracks.ts";
import type {TrackValue} from "../resolution/track-values.ts";
import type {Seconds} from "../types.ts";
import {lerp} from "../utils/math.ts";
import type {CSSValueResolver} from "./css-values.ts";
import {type NativeAnimationEffect, nativeEffectOf} from "./native-effects.ts";

/** Each element's properties, each with its effects in the order they show over each other in. */
export type AnimationTracks = Map<Element, { [property: string]: NativeAnimationEffect[] }>;

/** One effect's plays, placed in time, before its values and its easings. */
export interface PlacedEffect {
    delay: Seconds;
    duration: Seconds;
    iterations: number;
    direction: PlaybackDirection;
    fill: FillMode;
    /** In the time of one iteration, from 0 to `duration`. */
    run: TrackRun<TrackValue>;
}

type EffectTiming = Pick<PlacedEffect, 'delay' | 'duration' | 'iterations' | 'direction' | 'run'>;

/**
 * Turns tracks into WAAPI effects, in their tracks' order.
 * Each entry's extrapolations become iterations, or keyframes where WAAPI can't repeat them.
 * Its values become CSS text, every given one checked, and then its easings become native ones.
 */
export class NativeEffectsResolver {
    static resolve(tracks: Tracks, valueResolver: CSSValueResolver): AnimationTracks {
        return new Map([...tracks.byTarget].map(([element, tracksByProperty]) => [element, Object.fromEntries(
            Object.entries(tracksByProperty).map(([property, track]) => {
                const texts = new TrackValueTexts(valueResolver, element, property);
                for (const {keyedRun} of track) texts.checkGivenValuesOf(keyedRun);
                return [property, track.flatMap(entry => nativeTimingOf(entry).map(effect => nativeEffectOf(effect, entry.name, texts.textOf)))];
            })
        )]));
    }
}

/**
 * One property's values on one element as CSS text: a given value as it is, the current value as the element's computed one,
 * and an interpolated value as a number in the unit its ends come to. Each value's text is worked out once.
 */
class TrackValueTexts {
    private readonly textsByValue = new Map<TrackValue, string>();

    constructor(private readonly valueResolver: CSSValueResolver, private readonly element: Element, private readonly property: string) {}

    readonly textOf = (value: TrackValue): string => {
        let text = this.textsByValue.get(value);
        if (text === undefined) this.textsByValue.set(value, text = this.resolvedTextOf(value));
        return text;
    };

    /** Throws for a given value of the run that the property doesn't take, whether a keyframe shows it or not. */
    checkGivenValuesOf(run: TrackRun<TrackValue>): void {
        for (const {stops} of run.spans) {
            for (const {value} of stops.stops) {
                for (const givenValue of givenValuesOf(value)) this.textOf(givenValue);
            }
        }
    }

    private resolvedTextOf(value: TrackValue): string {
        const {valueResolver, element, property} = this;
        if (typeof value !== 'object') {
            const text = valueResolver.textOf(property, value);
            valueResolver.validate(property, text);
            return text;
        }
        if (value.type === 'currentValue') return valueResolver.currentValueOf(element, property);

        const startText = this.textOf(value.start);
        const endText = this.textOf(value.end);
        const {unit, numbersByText} = valueResolver.alignedNumbersOf(element, property, [startText, endText]);
        return `${lerp(numbersByText.get(startText)!, numbersByText.get(endText)!, value.factor)}${unit}`;
    }
}

/** The given values a value is made of. */
function givenValuesOf(value: TrackValue): TrackValue[] {
    if (typeof value !== 'object') return [value];
    return value.type === 'interpolated' ? [...givenValuesOf(value.start), ...givenValuesOf(value.end)] : [];
}

/**
 * The entry's extrapolations as WAAPI timing, in as many effects as it takes, each later by the entry's start.
 * The first effect holds before it when the entry does, and every effect holds after it when the entry does.
 */
function nativeTimingOf({start, duration, keyedRun, preExtrapolation, postExtrapolation}: TrackEntry): PlacedEffect[] {
    const repeatOptions: RepeatOptions = postExtrapolation && postExtrapolation.type !== 'hold' ? {
        repeat: postExtrapolation.iterations,
        repeatDelay: postExtrapolation.pause * duration,
        repeatMode: postExtrapolation.type === 'loop' ? 'loop' : postExtrapolation.flip === 'time' ? 'reverse' : 'mirror'
    } : {};
    const holdsAfter = postExtrapolation !== undefined && (postExtrapolation.type === 'hold' || postExtrapolation.holdsAfter);

    return nativelyRepeated(keyedRun, duration, repeatOptions).map((timing, index): PlacedEffect => {
        const holdsBefore = index === 0 && preExtrapolation !== undefined;
        const fill: FillMode = holdsBefore && holdsAfter ? 'both' : holdsBefore ? 'backwards' : holdsAfter ? 'forwards' : 'none';
        return {...timing, delay: start + timing.delay, fill};
    });
}

function timingOf(run: TrackRun<TrackValue>, iterations = 1, direction: PlaybackDirection = 'normal'): EffectTiming {
    return {run: run.shifted(-run.start), delay: run.start, duration: run.end - run.start, iterations, direction};
}

/** The repeat as WAAPI iterations, the first effect starting at the run's start. */
function nativelyRepeated(run: TrackRun<TrackValue>, iterationDuration: Seconds, options: RepeatOptions): EffectTiming[] {
    const {repeat: repeatCount = 0, repeatDelay = 0, repeatMode = 'loop'} = options;
    const period = iterationDuration + repeatDelay;
    const repeatsForever = !Number.isFinite(repeatCount);
    const playCount = repeatCount + 1;
    const iteration = (index: number) => run.iteration(index, iterationDuration, options);

    // run
    if (repeatCount === 0)
        return [timingOf(run)];

    // run × playCount, alternating for 'reverse'
    if (repeatMode !== 'mirror' && repeatDelay === 0 && run.start === 0 && run.end === iterationDuration)
        return [timingOf(run, playCount, repeatMode === 'reverse' ? 'alternate' : 'normal')];

    // [run+hold] × repeatCount, then run on its own; [run+hold] × ∞ when repeating forever
    if (repeatMode === 'loop') {
        const repeating = timingOf(run.heldUntil(run.start + period), repeatCount);
        return repeatsForever ? [repeating] : [repeating, timingOf(iteration(repeatCount))];
    }

    const repeatingPairs = (iterations: number) =>
        timingOf(TrackRun.joined([iteration(0), iteration(1)]).heldUntil(run.start + 2 * period), iterations);

    // [run+hold, flipped+hold] × ∞
    if (repeatsForever)
        return [repeatingPairs(Infinity)];

    // [run+hold, flipped+hold] × repeatCount/2, then run on its own
    if (playCount % 2 === 1)
        return [repeatingPairs(repeatCount / 2), timingOf(iteration(repeatCount))];

    const finalPair = timingOf(TrackRun.joined([iteration(repeatCount - 1), iteration(repeatCount)]));

    // [run+hold, flipped] on its own
    if (playCount === 2)
        return [finalPair];

    // [run+hold, flipped+hold] × (repeatCount−1)/2, then [run+hold, flipped] on its own
    return [repeatingPairs((repeatCount - 1) / 2), finalPair];
}
