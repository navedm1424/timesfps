import type {AnimationPlan, PlanNode, SequencePlan} from "../resolution/plan.ts";
import {entryPathOf, type EntryPath} from "../sequence-timing.ts";
import {TrackRun} from "../resolution/track-runs.ts";
import type {TweenStops} from "../tween-stops.ts";
import type {Seconds} from "../types.ts";
import {type CSSValueResolver, type EntryValues, resolveEffectChains} from "./effect-chains.ts";
import {type NativeAnimationEffect, nativeEffectOf} from "./native-effects.ts";
import type {RepeatOptions} from "../playback-options.ts";

/** Each element's properties, each with its effects in the order they're declared, which is the order they show over each other in. */
export type AnimationTracks = Map<Element, { [property: string]: NativeAnimationEffect[] }>;

/** Which element's property a run or an effect animates, and where its entry is declared, which decides what shows over what. */
interface TrackKey {
    element: Element;
    property: string;
    /** The animation leaf it comes from, which is undefined for an animation on its own. */
    path: EntryPath | undefined;
    /** The stops its entry gives the property, before any repeat flips them. */
    entryStops: TweenStops;
    order: readonly number[];
}

/** A track's plays in the time of one iteration, with the repeat still to play them. */
interface UnrepeatedRun extends TrackKey {
    run: TrackRun;
    iterationDuration: Seconds;
    repeatOptions: RepeatOptions;
    /** How much later than the outermost definition's start its first iteration starts. */
    offset: Seconds;
}

/** One effect's plays, placed in time, before its fill and its easings. */
export interface ScheduledEffect extends TrackKey {
    delay: Seconds;
    duration: Seconds;
    iterations: number;
    direction: PlaybackDirection;
    /** In the time of one iteration, from 0 to `duration`. */
    run: TrackRun;
}

export interface PlacedEffect extends ScheduledEffect {
    fill: FillMode;
}

/** An effect whose values are numbers in `unit`, or pass through to WAAPI as CSS text when it has none. */
export interface ResolvedEffect extends PlacedEffect {
    unit: string | undefined;
    values: EntryValues;
}

type EffectTiming = Pick<ScheduledEffect, 'delay' | 'duration' | 'iterations' | 'direction' | 'run'>;

/**
 * Resolves the plan into tracks in four stages: the repetitions, the fill conflicts, the values, then the easings.
 * Every repeat is an animation's own, and runs as WAAPI iterations.
 */
export class AnimationTracksResolver {
    static resolve(plan: PlanNode, valueResolver: CSSValueResolver): AnimationTracks {
        const effects = AnimationTracksResolver.unrepeatedRunsOf(plan, undefined, []).flatMap(repeatedEffectsOf);

        const effectsByTrack = new Map<Element, Map<string, ScheduledEffect[]>>();
        for (const effect of effects) {
            let effectsByProperty = effectsByTrack.get(effect.element);
            if (!effectsByProperty) effectsByTrack.set(effect.element, effectsByProperty = new Map());
            let trackEffects = effectsByProperty.get(effect.property);
            if (!trackEffects) effectsByProperty.set(effect.property, trackEffects = []);
            trackEffects.push(effect);
        }

        return new Map([...effectsByTrack].map(([element, effectsByProperty]) => [element, Object.fromEntries(
            [...effectsByProperty].map(([property, trackEffects]) => {
                const declared = trackEffects.sort((first, second) => compareOrders(first.order, second.order));
                const placed = AnimationTracksResolver.placeFills(declared);
                return [property, resolveEffectChains(element, property, placed, valueResolver).map(nativeEffectOf)];
            })
        )]));
    }

    private static unrepeatedRunsOf(plan: PlanNode, path: EntryPath | undefined, order: readonly number[]): UnrepeatedRun[] {
        switch (plan.type) {
            case 'animation':
                return AnimationTracksResolver.animationRunsOf(plan, path, order);
            case 'sequence':
                return AnimationTracksResolver.sequenceRunsOf(plan, path, order);
        }
    }

    /** One play of each property on each target, whose iterations start at the animation's position plus the target's delay. */
    private static animationRunsOf({definition, easing, playDuration, position, targets}: AnimationPlan, path: EntryPath | undefined, order: readonly number[]): UnrepeatedRun[] {
        return targets.flatMap(({target, delay}) => Object.entries(definition.stopsByProperty).map(([property, stops]): UnrepeatedRun => ({
            element: target, property, path, entryStops: stops, order,
            run: TrackRun.play(playDuration, easing, stops),
            iterationDuration: playDuration,
            repeatOptions: definition.timing.playback,
            offset: position + delay
        })));
    }

    /** Its entries' runs in their order, later by its position. */
    private static sequenceRunsOf(plan: SequencePlan, path: EntryPath | undefined, order: readonly number[]): UnrepeatedRun[] {
        return [...plan.entries].flatMap(([name, entryPlan], index) => AnimationTracksResolver.unrepeatedRunsOf(entryPlan, entryPathOf(path, name), [...order, index])
            .map(unrepeatedRun => ({...unrepeatedRun, offset: unrepeatedRun.offset + plan.position}))
        );
    }

    /**
     * Effects that are declared earlier and lie within a later one never show, so they're dropped.
     * Only the ones that start first fill backwards, and an effect fills forwards unless one declared before it runs on after it ends.
     */
    private static placeFills(effects: readonly ScheduledEffect[]): PlacedEffect[] {
        const endOf = ({delay, duration, iterations}: ScheduledEffect) => delay + (duration === 0 ? 0 : duration * iterations);
        const shown = effects.filter((effect, index) => !effects.some((later, laterIndex) =>
            laterIndex > index && later.delay <= effect.delay && endOf(effect) <= endOf(later)
        ));

        const firstStart = Math.min(...shown.map(({delay}) => delay));
        return shown.map((effect, index) => {
            const backwards = effect.delay === firstStart;
            const forwards = !shown.slice(0, index).some(earlier => endOf(earlier) > endOf(effect));
            const fill: FillMode = backwards && forwards ? 'both' : backwards ? 'backwards' : forwards ? 'forwards' : 'none';
            return {...effect, fill};
        });
    }
}

/** The run's repeat as WAAPI iterations, in as many effects as it takes, each ordered after the entry by its part. */
function repeatedEffectsOf({run, iterationDuration, repeatOptions, offset, ...key}: UnrepeatedRun): ScheduledEffect[] {
    return nativelyRepeated(run, iterationDuration, repeatOptions)
        .map((timing, index): ScheduledEffect => ({...key, order: [...key.order, index], ...timing, delay: timing.delay + offset}));
}

/** Earlier entries come first, and an entry's own parts in their order. */
function compareOrders(first: readonly number[], second: readonly number[]): number {
    for (let index = 0; index < Math.min(first.length, second.length); index++) {
        if (first[index] !== second[index]) return first[index]! - second[index]!;
    }
    return first.length - second.length;
}

function timingOf(run: TrackRun, iterations = 1, direction: PlaybackDirection = 'normal'): EffectTiming {
    return {run: run.shifted(-run.start), delay: run.start, duration: run.end - run.start, iterations, direction};
}

/** The repeat as WAAPI iterations, the first effect starting at the run's start. */
function nativelyRepeated(run: TrackRun, iterationDuration: Seconds, options: RepeatOptions): EffectTiming[] {
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
