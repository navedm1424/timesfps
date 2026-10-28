import {describe, expect, it} from "vitest";
import {AnimationTiming} from "../src/animation-timing.ts";
import {animation} from "../src/animation.ts";
import {AnimationValues, resolveTargets} from "../src/dom/mapping.ts";
import {CubicBezierEasing, type Easing, StepsEasing} from "../src/easing.ts";
import {linear} from "../src/easing-specifier.ts";
import {NumericStops} from "../src/resolution/stops.ts";
import {type AnimationPlan, plan, type SequencePlan} from "../src/resolution/plan.ts";
import {SequenceDefinition} from "../src/sequence.ts";
import {SequenceTiming} from "../src/sequence-timing.ts";
import type {PlaybackOptions, RepeatOptions} from "../src/playback-options.ts";
import {resolveTransition, type TransitionOptions} from "../src/transition.ts";
import type {Seconds} from "../src/types.ts";
import {lerp} from "../src/utils/math.ts";
import {sortedEntriesOf} from "../src/utils/records.ts";
import type {NativeAnimationEffect, NativeKeyframe} from "../src/waapi/native-effects.ts";
import {cssEasingOf, type NativeEasing} from "../src/waapi/native-easing.ts";
import {alignNumbers, type CSSValueResolver} from "../src/waapi/css-values.ts";
import {naming, type EntryPath} from "../src/naming.ts";
import {TracksResolver} from "../src/resolution/tracks.ts";
import {type AnimationTracks, NativeEffectsResolver} from "../src/waapi/tracks.ts";

const element = {} as Element;
const scope = {} as Element;
const line = {x: {0: 0, 1: 1}};

/** Values are plain numbers without a unit, and every property is 0.25 now; any text is a value, and computes as it is. */
const numericResolver: CSSValueResolver = {
    textOf: (_property, value) => String(value),
    currentValueOf: () => '0.25',
    validate: () => {},
    alignedNumbersOf: (_element, property, texts) => alignNumbers(property, texts, text => text)
};

function numericStopsOf(values: { [offset: number]: number }): NumericStops {
    return new NumericStops(sortedEntriesOf(values).map(([offset, value]) => ({offset, value})));
}

/** The same values played backwards, as a mirrored play shows them. */
function reversedOf(stops: NumericStops): NumericStops {
    return new NumericStops(stops.stops.map(({offset, value}) => ({offset: 1 - offset, value})).reverse());
}

function animationPlanOf(timing: AnimationTiming, elements: readonly Element[], values: AnimationValues = line): AnimationPlan {
    return plan(animation(elements, values, timing), target => resolveTargets(target, scope));
}

/** The timing's definition, with each animation leaf's values and elements by its path; a leaf without elements given has `element`. */
function sequencePlanOf(
    timing: SequenceTiming,
    valuesByPath: { [path: EntryPath]: AnimationValues },
    elementsByPath: { [path: EntryPath]: Element[] } = {}
): SequencePlan {
    const mappingOf = (sequenceTiming: SequenceTiming, path: EntryPath | undefined): object => Object.fromEntries(sequenceTiming.entries.map(entry => {
        const entryPath = naming.entryPathOf(path, entry.name);
        return [entry.name, 'sequence' in entry ? mappingOf(entry.sequence, entryPath) : [elementsByPath[entryPath] ?? [element], valuesByPath[entryPath]]];
    }));
    return plan(SequenceDefinition.of(timing, mappingOf(timing, undefined) as never), target => resolveTargets(target, scope));
}

/** Where an entry placed right after the sequence starts, which is the sequence's anchor duration; paths are within the sequence. */
function sequenceEndOf(
    sequence: SequenceTiming,
    valuesByPath: { [path: EntryPath]: AnimationValues },
    elementsByPath: { [path: EntryPath]: Element[] } = {}
): Seconds {
    const measuring = SequenceTiming.builder().add(sequence, 'measured').add(AnimationTiming.of({duration: 1}), 'next', 'measured>').build();
    const inMeasured = <Value>(byPath: { [path: EntryPath]: Value }) => Object.fromEntries(Object.entries(byPath).map(([path, value]) => [naming.entryPathOf('measured', path), value]));
    return sequencePlanOf(measuring, {...inMeasured(valuesByPath), next: line}, inMeasured(elementsByPath)).entries.get('next')!.position;
}

function animationTracksOf(timing: AnimationTiming, values: AnimationValues = line, elements = [element], resolver = numericResolver): AnimationTracks {
    return NativeEffectsResolver.resolve(new TracksResolver(animationPlanOf(timing, elements, values), naming).resolve(), resolver);
}

function sequenceTracksOf(
    timing: SequenceTiming,
    valuesByPath: { [path: EntryPath]: AnimationValues },
    elementsByPath: { [path: EntryPath]: Element[] } = {},
    resolver = numericResolver
): AnimationTracks {
    return NativeEffectsResolver.resolve(new TracksResolver(sequencePlanOf(timing, valuesByPath, elementsByPath), naming).resolve(), resolver);
}

function timingOf({delay, duration, iterations, direction, fill}: NativeAnimationEffect) {
    return {delay, duration, iterations, direction, fill};
}

function keyframesOf(effect: NativeAnimationEffect): number[][] {
    return effect.keyframes.map(({offset, value}) => [offset, Number(value)]);
}

function closeTo(rows: number[][]) {
    return rows.map(row => row.map(number => expect.closeTo(number, 9)));
}

/** The easing's output at `x`, as a browser computes it. */
function nativeProgressAt(easing: NativeEasing | undefined, x: number): number {
    if (!easing || easing.type === 'linear') return x;
    if (easing.type === 'cubic-bezier') return new CubicBezierEasing(easing.definition).progressAt(x);
    if (easing.type === 'steps') return new StepsEasing(easing.definition).progressAt(x);

    const {points} = easing;
    if (x >= points.at(-1)!.input) return points.at(-1)!.output;
    const index = points.findLastIndex(point => point.input <= x);
    const from = points[Math.max(index, 0)]!;
    const to = points[Math.max(index, 0) + 1]!;
    return to.input > from.input ? lerp(from.output, to.output, (x - from.input) / (to.input - from.input)) : to.output;
}

function keyframesValueAt(keyframes: readonly NativeKeyframe[], progress: number): number {
    const index = Math.min(Math.max(keyframes.findLastIndex(keyframe => keyframe.offset <= progress), 0), keyframes.length - 2);
    const from = keyframes[index]!;
    const to = keyframes[index + 1]!;
    if (to.offset === from.offset) return Number(to.value);
    return lerp(Number(from.value), Number(to.value), nativeProgressAt(from.easing, (progress - from.offset) / (to.offset - from.offset)));
}

/** The effect's value at `time`, or undefined when it has none then, as a browser computes it. */
function effectValueAt(effect: NativeAnimationEffect, time: number): number | undefined {
    const {delay, duration, iterations, direction, fill} = effect;
    const elapsed = time - delay;
    let iteration: number;
    let x: number;
    if (elapsed < 0) {
        if (fill !== 'backwards' && fill !== 'both') return undefined;
        [iteration, x] = [0, 0];
    } else if (elapsed >= duration * iterations) {
        if (fill !== 'forwards' && fill !== 'both') return undefined;
        [iteration, x] = [iterations - 1, 1];
    } else {
        iteration = Math.floor(elapsed / duration);
        x = elapsed / duration - iteration;
    }
    const backwards = direction === 'reverse'
        || (direction === 'alternate' && iteration % 2 === 1)
        || (direction === 'alternate-reverse' && iteration % 2 === 0);
    return keyframesValueAt(effect.keyframes, nativeProgressAt(effect.easing, backwards ? 1 - x : x));
}

/** The value the track shows at `time`: the last effect that has one, as later effects show over earlier ones. */
function trackValueAt(effects: readonly NativeAnimationEffect[], time: number): number | undefined {
    let value: number | undefined;
    for (const effect of effects) value = effectValueAt(effect, time) ?? value;
    return value;
}

/** The easing's progress at `x`, with its start and end values at its edges. */
function easedProgressAt(easing: Easing, x: number): number {
    if (x <= 0) return easing.startProgress;
    if (x >= 1) return easing.endProgress;
    return easing.progressAt(x);
}

/** What the definition means at `time`: each play through the stops, held through the repeat delays and after the last play. */
function definedValueAt(easing: Easing, stops: NumericStops, playDuration: number, options: RepeatOptions, time: number): number {
    const {repeat: repeatCount = 0, repeatDelay = 0, repeatMode = 'loop'} = options;
    const iteration = Math.min(Math.floor(time / (playDuration + repeatDelay)), repeatCount);
    const x = Math.min((time - iteration * (playDuration + repeatDelay)) / playDuration, 1);
    if (iteration % 2 === 0 || repeatMode === 'loop') return stops.valueAt(easedProgressAt(easing, x));
    if (repeatMode === 'reverse') return stops.valueAt(easedProgressAt(easing, 1 - x));
    return reversedOf(stops).valueAt(easedProgressAt(easing, x));
}

describe("plans", () => {
    const threeElements = [{} as Element, {} as Element, {} as Element];

    it("places an animation at its position, and ends it after its latest delay", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}, {delay: index => 0.25 + index * 0.5, repeat: 1, repeatDelay: 0.5}), 'a')
            .add(AnimationTiming.of({duration: 1}), 'next', 'a>')
            .build();
        const sequencePlan = sequencePlanOf(sequence, {a: line, next: line}, {a: threeElements});
        expect(sequencePlan.entries.get('a')).toMatchObject({position: 0, playDuration: 1});
        expect(sequencePlan.entries.get('next')).toMatchObject({position: 3.75});
    });

    it("counts only the first play of an infinite animation", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}, {delay: 0.5, repeat: Infinity}), 'a')
            .add(AnimationTiming.of({duration: 1}), 'next', 'a>')
            .build();
        const sequencePlan = sequencePlanOf(sequence, {a: line, next: line});
        expect(sequencePlan.entries.get('a')).toMatchObject({playDuration: 1});
        expect(sequencePlan.entries.get('next')).toMatchObject({position: 1.5});
    });

    it("resolves the targets, and gives each its delay", () => {
        const timing = AnimationTiming.of({duration: 1}, {delay: index => index * 0.5});
        expect(animationPlanOf(timing, threeElements).targets).toEqual(threeElements.map((target, index) => ({target, delay: index * 0.5})));
    });

    it("refers to an entry's start before its delay, and ends a sequence with its latest entry", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}), 'a')
            .add(AnimationTiming.of({duration: 2}, {delay: 0.25}), 'b', '+0.5')
            .add(AnimationTiming.of({duration: 1}), 'c', 'b<+0')
            .build();
        const sequencePlan = sequencePlanOf(sequence, {a: line, b: line, c: line});
        expect(sequencePlan.entries.get('b')).toMatchObject({position: 1.5});
        expect(sequencePlan.entries.get('c')).toMatchObject({position: 1.5});
        expect(sequencePlan).toMatchObject({position: 0, playDuration: 3.75});
        expect(sequenceEndOf(sequence, {a: line, b: line, c: line})).toBe(3.75);
    });

    it("measures a share of an entry from its position, its delay included", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}, {delay: 1}), 'a')
            .add(AnimationTiming.of({duration: 1}), 'b', 'a<+50%')
            .add(AnimationTiming.of({duration: 2}), 'c', 'b>-=50%')
            .build();
        const sequencePlan = sequencePlanOf(sequence, {a: line, b: line, c: line});
        expect(sequencePlan.entries.get('b')).toMatchObject({position: 1});
        expect(sequencePlan.entries.get('c')).toMatchObject({position: 1});
    });

    it("keeps an entry with no targets at its position, taking no time there, however it repeats", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}), 'a')
            .add(AnimationTiming.of({duration: 1}, {delay: 1, repeat: Infinity}), 'b', '>+2')
            .add(AnimationTiming.of({duration: 1}), 'c', 'b>')
            .add(AnimationTiming.of({duration: 1}), 'd', '>>+1')
            .build();
        const sequencePlan = sequencePlanOf(sequence, {a: line, b: line, c: line, d: line}, {b: [], d: []});
        expect(sequencePlan.entries.get('b')).toMatchObject({targets: [], position: 3, playDuration: 0});
        expect(sequencePlan.entries.get('c')).toMatchObject({position: 3});
        expect(sequencePlan.entries.get('d')).toMatchObject({position: 5});
        expect(sequencePlan).toMatchObject({playDuration: 5});
        expect(sequenceEndOf(sequence, {a: line, b: line, c: line, d: line}, {b: [], d: []})).toBe(5);
    });

});

describe("NativeEffectsResolver plans", () => {
    const play = {duration: 1};
    const effectsOf = (timing: AnimationTiming) => animationTracksOf(timing).get(element)!.x!;
    const repeats = (options: PlaybackOptions) => effectsOf(AnimationTiming.of(play, {repeatDelay: 0.5, ...options}));

    it("plays once with the easing on the effect and the stops as keyframes", () => {
        const [effect, ...rest] = effectsOf(AnimationTiming.of({duration: 1, easing: 'easeInOut'}));
        expect(rest).toEqual([]);
        expect(timingOf(effect!)).toEqual({delay: 0, duration: 1, iterations: 1, direction: 'normal', fill: 'both'});
        expect(effect!.easing).toEqual({type: 'cubic-bezier', definition: [0.42, 0, 0.58, 1]});
        expect(keyframesOf(effect!)).toEqual([[0, 0], [1, 1]]);
    });

    it("repeats natively without a repeat delay", () => {
        expect(effectsOf(AnimationTiming.of(play, {repeat: 2, repeatMode: 'loop'})).map(timingOf))
            .toEqual([{delay: 0, duration: 1, iterations: 3, direction: 'normal', fill: 'both'}]);
        expect(effectsOf(AnimationTiming.of(play, {repeat: 2, repeatMode: 'reverse'})).map(timingOf))
            .toEqual([{delay: 0, duration: 1, iterations: 3, direction: 'alternate', fill: 'both'}]);
    });

    it("loops as [original+hold] × repeatCount, then original on its own", () => {
        const effects = repeats({repeat: 2, repeatMode: 'loop'});
        expect(effects.map(timingOf)).toEqual([
            {delay: 0, duration: 1.5, iterations: 2, direction: 'normal', fill: 'both'},
            {delay: 3, duration: 1, iterations: 1, direction: 'normal', fill: 'forwards'}
        ]);
        expect(keyframesOf(effects[0]!)).toEqual(closeTo([[0, 0], [2 / 3, 1], [1, 1]]));
        expect(keyframesOf(effects[1]!)).toEqual(closeTo([[0, 0], [1, 1]]));
    });

    it("loops forever as [original+hold] × ∞", () => {
        expect(repeats({repeat: Infinity, repeatMode: 'loop'}).map(timingOf))
            .toEqual([{delay: 0, duration: 1.5, iterations: Infinity, direction: 'normal', fill: 'both'}]);
    });

    it("mirrors an odd play count as [original+hold, backward+hold] × repeatCount/2, then original on its own", () => {
        const effects = repeats({repeat: 2, repeatMode: 'mirror'});
        expect(effects.map(timingOf)).toEqual([
            {delay: 0, duration: 3, iterations: 1, direction: 'normal', fill: 'both'},
            {delay: 3, duration: 1, iterations: 1, direction: 'normal', fill: 'forwards'}
        ]);
        expect(keyframesOf(effects[0]!)).toEqual(closeTo([[0, 0], [1 / 3, 1], [0.5, 1], [5 / 6, 0], [1, 0]]));
    });

    it("mirrors an even play count as [original+hold, backward+hold] × (playCount−2)/2, then [original+hold, backward] once", () => {
        const effects = repeats({repeat: 3, repeatMode: 'mirror'});
        expect(effects.map(timingOf)).toEqual([
            {delay: 0, duration: 3, iterations: 1, direction: 'normal', fill: 'both'},
            {delay: 3, duration: 2.5, iterations: 1, direction: 'normal', fill: 'forwards'}
        ]);
        expect(keyframesOf(effects[1]!)).toEqual(closeTo([[0, 0], [0.4, 1], [0.6, 1], [1, 0]]));
    });

    it("mirrors two plays as [original+hold, backward] once", () => {
        expect(repeats({repeat: 1, repeatMode: 'mirror'}).map(timingOf))
            .toEqual([{delay: 0, duration: 2.5, iterations: 1, direction: 'normal', fill: 'both'}]);
    });

    it("mirrors forever as [original+hold, backward+hold] × ∞", () => {
        expect(repeats({repeat: Infinity, repeatMode: 'mirror'}).map(timingOf))
            .toEqual([{delay: 0, duration: 3, iterations: Infinity, direction: 'normal', fill: 'both'}]);
    });

    it("puts each keyframe's easing on the way to the next one", () => {
        const [repeating] = animationTracksOf(AnimationTiming.of({duration: 1, easing: 'easeIn'}, {repeat: 1, repeatDelay: 0.5})).get(element)!.x!;
        expect(repeating!.keyframes.map(({easing}) => easing?.type)).toEqual(['cubic-bezier', undefined, undefined]);
    });

    it("jumps to the end values for a play without duration", () => {
        const effects = effectsOf(AnimationTiming.of({duration: 0}));
        expect(effects.map(timingOf)).toEqual([{delay: 0, duration: 0, iterations: 1, direction: 'normal', fill: 'both'}]);
        expect(keyframesOf(effects[0]!)).toEqual([[0, 0], [1, 1]]);
    });

    it("plays a play without duration once, whatever its repeats", () => {
        const effects = effectsOf(AnimationTiming.of({duration: 0}, {repeat: 1, repeatDelay: 0.5, repeatMode: 'mirror'}));
        expect(effects.map(timingOf)).toEqual([{delay: 0, duration: 0, iterations: 1, direction: 'normal', fill: 'both'}]);
        expect([trackValueAt(effects, 0.25), trackValueAt(effects, 1)]).toEqual([1, 1]);
    });

    it("adds each element's staggered delay to its effects", () => {
        const elements = [{} as Element, {} as Element, {} as Element];
        const timing = AnimationTiming.of({duration: 1}, {repeat: 2, repeatDelay: 0.5, repeatMode: 'loop', delay: index => index * 0.25});
        const tracks = animationTracksOf(timing, line, elements);
        expect(elements.map(element => tracks.get(element)!.x!.map(({delay}) => delay))).toEqual([[0, 3], [0.25, 3.25], [0.5, 3.5]]);
    });
});

const valuesWithStop = {x: {0: 0, 0.4: 0.7, 1: 1}};
const stopsWithStop = numericStopsOf(valuesWithStop.x);
const transitions: [string, TransitionOptions, number][] = [
    ['a cubic Bézier easing', {duration: 1, easing: 'easeInOut'}, 1e-6],
    ['an overshooting cubic Bézier easing', {duration: 1, easing: [0.3, 1.6, 0.6, 1]}, 1e-6],
    ['a jump-start steps easing', {duration: 1, easing: [4, 'jumpStart']}, 1e-6],
    ['a jump-end steps easing', {duration: 1, easing: [3, 'jumpEnd']}, 1e-6],
    ['a spring', {duration: 1, bounce: 0.4}, 2e-3]
];

/**
 * Compares the track with the defined value from the track's first start on, at times that miss the round ones, where steps and repeats jump.
 * Before it, a fill backwards shows a jump right at the start as already made, which only an effect's own steps easing avoids.
 */
function expectTrackToFollow(effects: readonly NativeAnimationEffect[], definedAt: (time: number) => number, tolerance: number, span: number, label = '') {
    const sampleCount = 1999;
    const firstStart = Math.min(...effects.map(({delay}) => delay));
    for (let sample = 0; sample < sampleCount; sample++) {
        const time = firstStart + (sample + 0.37) / sampleCount * span;
        expect(Math.abs(trackValueAt(effects, time)! - definedAt(time)), `${label} at ${time}`).toBeLessThan(tolerance);
    }
}

describe("NativeEffectsResolver values", () => {
    const repeatings: RepeatOptions[] = [
        {},
        {repeat: 2, repeatMode: 'loop'},
        ...(['loop', 'reverse', 'mirror'] as const).flatMap(repeatMode => [
            {repeat: 2, repeatDelay: 0.5, repeatMode},
            {repeat: 3, repeatDelay: 0.5, repeatMode},
            {repeat: Infinity, repeatDelay: 0.5, repeatMode}
        ])
    ];

    for (const [name, transition, tolerance] of transitions) {
        it(`follows ${name} through every repeat`, () => {
            for (const options of repeatings) {
                const timing = AnimationTiming.of(transition, options);
                const {duration, easing} = resolveTransition(timing.transition);
                const effects = animationTracksOf(timing, valuesWithStop).get(element)!.x!;
                const definedAt = (time: number) => definedValueAt(easing, stopsWithStop, duration, options, time);
                expectTrackToFollow(effects, definedAt, tolerance, 10, JSON.stringify(options));
            }
        });
    }
});

describe("NativeEffectsResolver sequences", () => {
    const sample = (effects: readonly NativeAnimationEffect[], times: number[]) => times.map(time => trackValueAt(effects, time));

    it("keeps entries that don't overlap apart, in the order they start, each holding after it and only the first before it", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}), 'a', 2)
            .add(AnimationTiming.of({duration: 1}), 'b', 0)
            .build();
        const effects = sequenceTracksOf(sequence, {a: {x: {0: 0, 1: 1}}, b: {x: {0: 5, 1: 6}}}).get(element)!.x!;
        expect(effects.map(({name, delay, fill}) => ({name, delay, fill}))).toEqual([{name: 'b', delay: 0, fill: 'both'}, {name: 'a', delay: 2, fill: 'forwards'}]);
        expect(sample(effects, [1.5, 2.5, 4])).toEqual([6, 0.5, 1]);
    });

    it("keeps entries whose ends only touch apart", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}), 'a')
            .add(AnimationTiming.of({duration: 1}), 'b')
            .build();
        expect(sequenceTracksOf(sequence, {a: line, b: line}).get(element)!.x!.map(({name}) => name)).toEqual(['a', 'b']);
    });

    it("layers entries that overlap, the one that starts later over the earlier, whichever is declared first", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 2}), 'a', 0.5)
            .add(AnimationTiming.of({duration: 1}), 'b', 0)
            .build();
        const effects = sequenceTracksOf(sequence, {a: {x: line.x}, b: {x: line.x}}).get(element)!.x!;
        expect(effects.map(effect => ({name: effect.name, ...timingOf(effect)}))).toEqual([
            {name: 'b', delay: 0, duration: 1, iterations: 1, direction: 'normal', fill: 'both'},
            {name: 'a', delay: 0.5, duration: 2, iterations: 1, direction: 'normal', fill: 'forwards'}
        ]);
        expect(sample(effects, [0.25, 0.75, 2])).toEqual(closeTo([[0.25, 0.125, 0.75]])[0]);
    });

    it("puts an entry over one that starts with it when it's declared later, and shows the earlier one again once it ends", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 2}), 'a', 0)
            .add(AnimationTiming.of({duration: 1}), 'b', 0)
            .build();
        const effects = sequenceTracksOf(sequence, {a: {x: line.x}, b: {x: {0: 5, 1: 6}}}).get(element)!.x!;
        expect(sample(effects, [0.5, 1.5])).toEqual(closeTo([[5.5, 0.75]])[0]);
    });

    it("keeps the repeats of an entry with another over it as its own", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}, {repeat: 2}), 'a')
            .add(AnimationTiming.of({duration: 0.5}), 'b', 1.5)
            .build();
        const effects = sequenceTracksOf(sequence, {a: line, b: {x: {0: 5, 1: 6}}}).get(element)!.x!;
        expect(effects.map(timingOf)).toEqual([
            {delay: 0, duration: 1, iterations: 3, direction: 'normal', fill: 'both'},
            {delay: 1.5, duration: 0.5, iterations: 1, direction: 'normal', fill: 'none'}
        ]);
        expect(sample(effects, [0.5, 1.75, 2.5])).toEqual(closeTo([[0.5, 5.5, 0.5]])[0]);
    });

    it("keeps an entry without duration that falls within another apart", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 2}), 'a')
            .add(AnimationTiming.of({duration: 0}), 'b', 1)
            .build();
        expect(sequenceTracksOf(sequence, {a: line, b: {x: {0: 5, 1: 6}}}).get(element)!.x!.map(({name}) => name)).toEqual(['a', 'b']);
    });

    it("layers an entry that repeats forever between the entries that start before and after it", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 2}), 'a', 0)
            .add(AnimationTiming.of({duration: 1}, {repeat: Infinity}), 'i', 1)
            .add(AnimationTiming.of({duration: 1.5}), 'b', 1.5)
            .build();
        const effects = sequenceTracksOf(sequence, {a: line, i: {x: {0: 10, 1: 11}}, b: {x: {0: 5, 1: 6}}}).get(element)!.x!;
        expect(effects.map(({name}) => name)).toEqual(['a', 'i', 'b']);
        expect(sample(effects, [0.5, 1.25, 2.25, 3.5])).toEqual(closeTo([[0.25, 10.25, 5.5, 10.5]])[0]);
    });

    it("keeps an entry that repeats forever apart, and doesn't hold an entry over it after it ends", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}, {repeat: Infinity}), 'a')
            .add(AnimationTiming.of({duration: 1}), 'b', 2)
            .build();
        const effects = sequenceTracksOf(sequence, {a: line, b: {x: {0: 5, 1: 6}}}).get(element)!.x!;
        expect(effects.map(({name, iterations, fill}) => ({name, iterations, fill})))
            .toEqual([{name: 'a', iterations: Infinity, fill: 'both'}, {name: 'b', iterations: 1, fill: 'none'}]);
        expect(sample(effects, [2.5, 3.5])).toEqual(closeTo([[5.5, 0.5]])[0]);
    });

    it("sets an entry without duration at its position, between the entries around it", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}), 'a')
            .add(AnimationTiming.of({duration: 0}), 'b', '+0.5')
            .add(AnimationTiming.of({duration: 1}), 'c', '+0.5')
            .build();
        const effects = sequenceTracksOf(sequence, {a: {x: line.x}, b: {x: {0: 0.25, 1: 0.75}}, c: {x: {0: 0.75, 1: 0}}}).get(element)!.x!;
        expect(sample(effects, [1.25, 1.75, 2.5, 3.5])).toEqual(closeTo([[1, 0.75, 0.375, 0]])[0]);
    });

    it("shows an entry that starts within an earlier one over it, while it runs", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 0.5}), 'a', 0.25)
            .add(AnimationTiming.of({duration: 1}), 'b', 0)
            .build();
        const effects = sequenceTracksOf(sequence, {a: {x: {0: 5, 1: 6}}, b: {x: line.x}}).get(element)!.x!;
        expect(effects).toHaveLength(2);
        expect(sample(effects, [0.125, 0.5, 0.875])).toEqual(closeTo([[0.125, 5.5, 0.875]])[0]);
    });
});

describe("NativeEffectsResolver missing values", () => {
    const sample = (effects: readonly NativeAnimationEffect[], times: number[]) => times.map(time => trackValueAt(effects, time));

    it("ends an entry without a value at 1 on the start of the entry after it", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}), 'a')
            .add(AnimationTiming.of({duration: 1}), 'b', '+0.5')
            .build();
        const [a] = sequenceTracksOf(sequence, {a: {x: {0: 0}}, b: {x: {0: 5, 1: 6}}}).get(element)!.x!;
        expect(keyframesOf(a!)).toEqual([[0, 0], [1, 5]]);
    });

    it("starts an entry over another without a value at 0 from the value of the one under it there", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}), 'a')
            .add(AnimationTiming.of({duration: 1}), 'b', '-0.5')
            .build();
        const effects = sequenceTracksOf(sequence, {a: {x: {0: 0, 1: 1}}, b: {x: {1: 2}}}).get(element)!.x!;
        expect(sample(effects, [0.25, 0.75, 1.5])).toEqual(closeTo([[0.25, 0.875, 2]])[0]);
    });

    it("ends an entry over another without a value at 1 on the value of the one under it there", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 2}), 'a')
            .add(AnimationTiming.of({duration: 0.5}), 'b', 0.5)
            .build();
        const effects = sequenceTracksOf(sequence, {a: line, b: {x: {0: 3}}}).get(element)!.x!;
        expect(sample(effects, [0.75])).toEqual(closeTo([[1.75]])[0]);
    });

    it("starts an entry over one that repeats forever from the last stop that one reached", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}, {repeat: Infinity}), 'a')
            .add(AnimationTiming.of({duration: 1}), 'b', 1.5)
            .build();
        const [, b] = sequenceTracksOf(sequence, {a: {x: {0: 0, 0.5: 0.7, 1: 1}}, b: {x: {1: 6}}}).get(element)!.x!;
        expect(keyframesOf(b!)).toEqual([[0, 0.7], [1, 6]]);
    });

    it("starts an entry from one under it that starts at the same moment, and takes nothing from one that ends at the same moment", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 2}), 'a')
            .add(AnimationTiming.of({duration: 2}), 'b', 0)
            .build();
        const effects = sequenceTracksOf(sequence, {a: line, b: {x: {0.5: 6}}}).get(element)!.x!;
        expect(sample(effects, [0, 2])).toEqual([0, 0.25]);
    });

    it("starts an entry without a value at 0 and nothing before it from the property's current value", () => {
        const effects = animationTracksOf(AnimationTiming.of({duration: 1}), {x: {1: 1}}).get(element)!.x!;
        expect(keyframesOf(effects[0]!)).toEqual([[0, 0.25], [1, 1]]);
    });
});

describe("NativeEffectsResolver values passed through", () => {
    /** Takes any text, and has numbers only for plain numbers; colours have none. */
    const textResolver: CSSValueResolver = {...numericResolver, currentValueOf: () => 'none'};
    const textsOf = (effect: NativeAnimationEffect) => effect.keyframes.map(({value}) => value);
    const resolvedWith = (timing: AnimationTiming, values: AnimationValues) => animationTracksOf(timing, values, [element], textResolver).get(element)!;

    it("passes values through as text when the easing is on the effect", () => {
        const [effect] = resolvedWith(AnimationTiming.of({duration: 1, easing: 'easeOut'}), {color: {0: 'red', 0.5: 'white', 1: 'blue'}}).color!;
        expect(textsOf(effect!)).toEqual(['red', 'white', 'blue']);
    });

    it("passes values through when each span is one whole native easing between two stops", () => {
        const [effect] = resolvedWith(AnimationTiming.of({duration: 1, easing: 'easeOut'}, {repeat: 1, repeatDelay: 0.5}), {color: {0: 'red', 1: 'blue'}}).color!;
        expect(textsOf(effect!)).toEqual(['red', 'blue', 'blue']);
    });

    it("passes values through a reversed play whose easing needn't be split", () => {
        const timing = AnimationTiming.of({duration: 1, easing: 'easeOut'}, {repeat: 1, repeatDelay: 0.5, repeatMode: 'reverse'});
        const [effect] = resolvedWith(timing, {color: {0: 'red', 1: 'blue'}}).color!;
        expect(textsOf(effect!)).toEqual(['red', 'blue', 'blue', 'red']);
        expect(effect!.keyframes[2]!.easing).toEqual({type: 'cubic-bezier', definition: [1 - 0.58, 0, 1, 1]});
    });

    it("passes values through an overshooting Bézier between two stops in a repeat", () => {
        const timing = AnimationTiming.of({duration: 1, easing: [0.3, 1.6, 0.6, 1]}, {repeat: 1, repeatDelay: 0.5, repeatMode: 'mirror'});
        const [effect] = resolvedWith(timing, {color: {0: 'red', 1: 'blue'}}).color!;
        expect(textsOf(effect!)).toEqual(['red', 'blue', 'blue', 'red']);
    });

    it("starts from the current value as it is", () => {
        const [effect] = resolvedWith(AnimationTiming.of({duration: 1}), {translate: {1: '10px'}}).translate!;
        expect(textsOf(effect!)).toEqual(['none', '10px']);
    });

    it("starts an entry from the stop the track holds as it starts", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}), 'a')
            .add(AnimationTiming.of({duration: 1}), 'b', '+0.5')
            .build();
        const [, b] = sequenceTracksOf(sequence, {a: {color: {0: 'red', 1: 'blue'}}, b: {color: {1: 'green'}}}, {}, textResolver).get(element)!.color!;
        expect(textsOf(b!)).toEqual(['blue', 'green']);
    });

    it("needs numbers for a spring", () => {
        expect(() => resolvedWith(AnimationTiming.of({duration: 1, bounce: 0.3}), {color: {0: 'red', 1: 'blue'}})).toThrow();
        const [effect] = resolvedWith(AnimationTiming.of({duration: 1, bounce: 0.3}), {x: {0: '0', 1: '1'}}).x!;
        expect(effect!.keyframes.length).toBeGreaterThan(2);
    });
});

describe("cssEasingOf", () => {
    it("writes each native easing as CSS", () => {
        expect(cssEasingOf({type: 'steps', definition: [4, 'jumpStart']})).toBe('steps(4, jump-start)');
        expect(cssEasingOf({type: 'linear-points', points: [{input: 0, output: 0}, {input: 0.5, output: 0}, {input: 0.5, output: 1}, {input: 1, output: 1}]}))
            .toBe('linear(0 0%, 0 50%, 1 50%, 1 100%)');
    });
});

describe("Easing windows", () => {
    it("gives the progress of the window without rescaling it, and runs it backwards when reversed", () => {
        const easing = linear.segment(0.25, 0.75);
        expect([easing.progressAt(0), easing.progressAt(1), easing.reverse().progressAt(0)]).toEqual([0.25, 0.75, 0.75]);
        expect(easing.offsetsAt(0.5)).toEqual([0.5]);
    });
});
