import {type ByElementAndProperty, mapByElementAndProperty} from "../dom/mapping.ts";
import {KeyedRamp} from "../tracks/keyed-ramps.ts";
import type {TrackEntry, TrackRunTiming} from "../tracks/track-entries.ts";
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
    ramp: KeyedRamp<TrackValue>;
}

type EffectTiming = Pick<PlacedEffect, 'delay' | 'duration' | 'iterations' | 'direction' | 'ramp'>;

/**
 * Turns tracks into WAAPI effects, in their tracks' order.
 * Each entry's extrapolations become iterations, or keyframes where WAAPI can't repeat them.
 * Its values become CSS text, every given one checked, and then its easings become native ones.
 */
export class NativeEffectsResolver {
    static resolve(tracks: Tracks, valueResolver: CSSValueResolver): AnimationTracks {
        return mapByElementAndProperty(tracks, (track, element, property) => {
            const texts = new TrackValueTexts(valueResolver, element, property);
            for (const {keyedRamp} of track) texts.checkGivenValuesOf(keyedRamp);
            return track.flatMap(entry => nativeTimingOf(entry).map(effect => nativeEffectOf(effect, entry.name, texts.textOf)));
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

    /** Throws for a given value of the ramp that the property doesn't take, whether a keyframe shows it or not. */
    checkGivenValuesOf(ramp: KeyedRamp<TrackValue>): void {
        for (const {stops} of ramp.spans) {
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

        const fromText = this.textOf(value.from);
        const toText = this.textOf(value.to);
        const {unit, numbersByText} = valueResolver.alignedNumbersOf(element, property, [fromText, toText]);
        return `${lerp(numbersByText.get(fromText)!, numbersByText.get(toText)!, value.factor)}${unit}`;
    }
}

/** The given values a value is made of. */
function givenValuesOf(value: TrackValue): TrackValue[] {
    if (typeof value !== 'object') return [value];
    return value.type === 'interpolated' ? [...givenValuesOf(value.from), ...givenValuesOf(value.to)] : [];
}

/**
 * The entry's run as WAAPI timing, in as many effects as it takes, each later by the entry's start.
 * The first effect holds before it when the entry does, and every effect holds after it when the entry does.
 */
function nativeTimingOf(entry: TrackEntry): PlacedEffect[] {
    const {start, keyedRamp, holdsBefore, holdsAfter} = entry;
    return nativelyRepeated(keyedRamp, entry).map((timing, index): PlacedEffect => {
        const fillsBackwards = index === 0 && holdsBefore;
        const fill: FillMode = fillsBackwards && holdsAfter ? 'both' : fillsBackwards ? 'backwards' : holdsAfter ? 'forwards' : 'none';
        return {...timing, delay: start + timing.delay, fill};
    });
}

function timingOf(ramp: KeyedRamp<TrackValue>, iterations = 1, direction: PlaybackDirection = 'normal'): EffectTiming {
    return {ramp: ramp.shifted(-ramp.start), delay: ramp.start, duration: ramp.end - ramp.start, iterations, direction};
}

/** The repeat as WAAPI iterations, the first effect starting at the ramp's start. */
function nativelyRepeated(ramp: KeyedRamp<TrackValue>, {duration: iterationDuration, repeatCount, repeatDelay, oscillate}: Omit<TrackRunTiming, 'start'>): EffectTiming[] {
    const period = iterationDuration + repeatDelay;
    const repeatsForever = !Number.isFinite(repeatCount);
    const playCount = repeatCount + 1;
    const iteration = (index: number) => ramp.iteration(index, iterationDuration, repeatDelay, oscillate);

    // ramp
    if (repeatCount === 0)
        return [timingOf(ramp)];

    // ramp × playCount, alternating when it oscillates in time
    if (oscillate !== 'values' && repeatDelay === 0 && ramp.start === 0 && ramp.end === iterationDuration)
        return [timingOf(ramp, playCount, oscillate === 'time' ? 'alternate' : 'normal')];

    // [ramp+hold] × repeatCount, then ramp on its own; [ramp+hold] × ∞ when repeating forever
    if (!oscillate) {
        const repeating = timingOf(ramp.heldUntil(ramp.start + period), repeatCount);
        return repeatsForever ? [repeating] : [repeating, timingOf(iteration(repeatCount))];
    }

    const repeatingPairs = (iterations: number) =>
        timingOf(KeyedRamp.joined([iteration(0), iteration(1)]).heldUntil(ramp.start + 2 * period), iterations);

    // [ramp+hold, flipped+hold] × ∞
    if (repeatsForever)
        return [repeatingPairs(Infinity)];

    // [ramp+hold, flipped+hold] × repeatCount/2, then ramp on its own
    if (playCount % 2 === 1)
        return [repeatingPairs(repeatCount / 2), timingOf(iteration(repeatCount))];

    const finalPair = timingOf(KeyedRamp.joined([iteration(repeatCount - 1), iteration(repeatCount)]));

    // [ramp+hold, flipped] on its own
    if (playCount === 2)
        return [finalPair];

    // [ramp+hold, flipped+hold] × (repeatCount−1)/2, then [ramp+hold, flipped] on its own
    return [repeatingPairs((repeatCount - 1) / 2), finalPair];
}
