import {type ByElementAndProperty, mapByElementAndProperty} from "../dom/mapping.ts";
import type {TrackRun, TrackRunSpan} from "../tracks/track-runs.ts";
import type {Tracks} from "../tracks/tracks.ts";
import type {TrackValue} from "../tracks/track-values.ts";
import type {Seconds} from "../types.ts";
import {lerp} from "../utils/math.ts";
import type {CSSValueResolver} from "./css-values.ts";
import {type NativeAnimationEffect, nativeEffectOf} from "./native-effects.ts";

/** Each element's properties, each with its effects in the order they show over each other in. */
export type AnimationTracks = ByElementAndProperty<NativeAnimationEffect[]>;

/** One effect's plays, placed in time, before its values and its easings. */
export interface PlacedEffect {
    delay: Seconds;
    duration: Seconds;
    iterations: number;
    direction: PlaybackDirection;
    fill: FillMode;
    /** In the time of one iteration, from 0 to `duration`. */
    spans: readonly TrackRunSpan<TrackValue>[];
}

type EffectTiming = Pick<PlacedEffect, 'delay' | 'duration' | 'iterations' | 'direction' | 'spans'>;

/**
 * Turns tracks into WAAPI effects, in their tracks' order.
 * Each run's repeats become iterations, or keyframes where WAAPI can't repeat them.
 * Its values become CSS text, every given one checked, and then its easings become native ones.
 */
export class NativeEffectsResolver {
    static resolve(tracks: Tracks, valueResolver: CSSValueResolver): AnimationTracks {
        return mapByElementAndProperty(tracks, (track, element, property) => {
            const texts = new TrackValueTexts(valueResolver, element, property);
            for (const run of track) texts.checkGivenValuesOf(run);
            return track.flatMap(run => nativeTimingOf(run).map(effect => nativeEffectOf(effect, run.name, texts.textOf)));
        });
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
            for (const {value} of stops) {
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

        const fromText = this.textOf(value.from);
        const toText = this.textOf(value.to);
        const {unit, numbersByText} = valueResolver.alignedNumbersOf(element, property, [fromText, toText]);
        return `${lerp(numbersByText.get(fromText)!, numbersByText.get(toText)!, value.factor)}${unit}`;
    }
}

/** The given values a value is made of. */
function givenValuesOf(value: TrackValue): TrackValue[] {
    if (typeof value !== 'object') return [value];
    return value.type === 'interpolation' ? [...givenValuesOf(value.from), ...givenValuesOf(value.to)] : [];
}

/**
 * The run as WAAPI timing, in as many effects as it takes.
 * The first effect holds before it when the run does, and every effect holds after it when the run does.
 */
function nativeTimingOf(run: TrackRun<TrackValue>): PlacedEffect[] {
    const {holdsBefore, holdsAfter} = run;
    return nativelyRepeated(run).map((timing, index): PlacedEffect => {
        const fillsBackwards = index === 0 && holdsBefore;
        const fill: FillMode = fillsBackwards && holdsAfter ? 'both' : fillsBackwards ? 'backwards' : holdsAfter ? 'forwards' : 'none';
        return {...timing, fill};
    });
}

/** The timing of an effect that plays the spans, from where they start. */
function timingOf(spans: readonly TrackRunSpan<TrackValue>[], iterations = 1, direction: PlaybackDirection = 'normal'): EffectTiming {
    const start = spans[0]!.start;
    return {spans: spans.map(span => span.shift(-start)), delay: start, duration: spans.at(-1)!.end - start, iterations, direction};
}

/** The run's repeats as WAAPI iterations. */
function nativelyRepeated(run: TrackRun<TrackValue>): EffectTiming[] {
    const {timing: {duration: iterationDuration, repeatCount, repeatDelay, oscillate}, spans} = run;
    const repeatsForever = !Number.isFinite(repeatCount);
    const playCount = repeatCount + 1;
    const iteration = (index: number) => run.iterationSpans(index, index);

    // iteration
    if (repeatCount === 0)
        return [timingOf(iteration(0))];

    // iteration × playCount, alternating when it oscillates in time
    if (oscillate !== 'values' && repeatDelay === 0 && spans[0]!.start === 0 && spans.at(-1)!.end === iterationDuration)
        return [timingOf(iteration(0), playCount, oscillate === 'time' ? 'alternate' : 'normal')];

    // [iteration+hold] × repeatCount, then iteration on its own; [iteration+hold] × ∞ when repeating forever
    if (!oscillate) {
        const repeating = timingOf(run.iterationSpans(0, 0, {holdsUntilNext: true}), repeatCount);
        return repeatsForever ? [repeating] : [repeating, timingOf(iteration(repeatCount))];
    }

    const repeatingPairs = (iterations: number) => timingOf(run.iterationSpans(0, 1, {holdsUntilNext: true}), iterations);

    // [iteration+hold, flipped+hold] × ∞
    if (repeatsForever)
        return [repeatingPairs(Infinity)];

    // [iteration+hold, flipped+hold] × repeatCount/2, then iteration on its own
    if (playCount % 2 === 1)
        return [repeatingPairs(repeatCount / 2), timingOf(iteration(repeatCount))];

    const finalPair = timingOf(run.iterationSpans(repeatCount - 1, repeatCount));

    // [iteration+hold, flipped] on its own
    if (playCount === 2)
        return [finalPair];

    // [iteration+hold, flipped+hold] × (repeatCount−1)/2, then [iteration+hold, flipped] on its own
    return [repeatingPairs((repeatCount - 1) / 2), finalPair];
}
