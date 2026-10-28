import {describe, expect, it, vi} from "vitest";
import {AnimationTiming} from "../src/animation-timing.ts";
import {type At, parsePositionDescriptor, resolvePosition} from "../src/at.ts";
import {animation, AnimationDefinition} from "../src/animation.ts";
import {plan} from "../src/resolution/plan.ts";
import {sequence, SequenceDefinition} from "../src/sequence.ts";
import {SequenceTiming} from "../src/sequence-timing.ts";
import {resolveTargets} from "../src/dom/mapping.ts";
import {TweenStops} from "../src/tween-stops.ts";

const second = AnimationTiming.of({duration: 1});

const offset = (seconds: number, referenceFraction = 0, selfFraction = 0) => ({seconds, referenceFraction, selfFraction});

const namesOf = (timing: SequenceTiming) => timing.entries.map(({name}) => name);

describe("parsePositionDescriptor", () => {
    it("reads the previous entry's end and start, the start of the sequence, and the end of everything so far", () => {
        expect(parsePositionDescriptor('')).toEqual({reference: {kind: 'previousEntry'}, anchor: 'end', offset: offset(0)});
        expect(parsePositionDescriptor('>')).toEqual({reference: {kind: 'previousEntry'}, anchor: 'end', offset: offset(0)});
        expect(parsePositionDescriptor('-0.3' as At<never>)).toEqual({reference: {kind: 'previousEntry'}, anchor: 'end', offset: offset(-0.3)});
        expect(parsePositionDescriptor('<+0.1' as At<never>)).toEqual({reference: {kind: 'previousEntry'}, anchor: 'start', offset: offset(0.1)});
        expect(parsePositionDescriptor('<<')).toEqual({reference: {kind: 'everythingSoFar'}, anchor: 'start', offset: offset(0)});
        expect(parsePositionDescriptor('>>+0.5' as At<never>)).toEqual({reference: {kind: 'everythingSoFar'}, anchor: 'end', offset: offset(0.5)});
    });

    it("reads a number as an offset in seconds from the start of the sequence", () => {
        expect(parsePositionDescriptor(1.5)).toEqual(parsePositionDescriptor('<<+1.5' as At<never>));
    });

    it("reads names, with or without an anchor", () => {
        expect(parsePositionDescriptor<'title'>('title')).toEqual({reference: {kind: 'entry', name: 'title'}, anchor: 'end', offset: offset(0)});
        expect(parsePositionDescriptor<'title'>('title<+50%' as At<'title'>)).toEqual({reference: {kind: 'entry', name: 'title'}, anchor: 'start', offset: offset(0, 0.5)});
    });

    it("reads one offset of each kind: a share of the reference, a share of the entry's own duration, then seconds", () => {
        expect(parsePositionDescriptor('<+50%+=50%-1').offset).toEqual(offset(-1, 0.5, 0.5));
        expect(parsePositionDescriptor('-=25%+1e-1').offset).toEqual(offset(0.1, 0, -0.25));
    });

    it("rejects what isn't a position", () => {
        for (const at of ['+=1', '<0.2', 'title>>', 'title<<', '<+-1', '>-+50%', '+abc', '+1abc', '1.5', '<<<', '<+1-1', '<+50%-25%', '+=5%-=5%', '<-1+50%', '+=50%+50%'])
            expect(() => parsePositionDescriptor(at as At<'title'>), at).toThrow(SyntaxError);
    });
});

describe("resolvePosition", () => {
    const spans = new Map([['a', {start: 1, duration: 2}], ['b', {start: 0, duration: 1}]]);
    const resolve = (at: string, selfDuration = 4) => resolvePosition(parsePositionDescriptor(at as At<'a' | 'b'>), spans, selfDuration);

    it("measures from the previous entry, a named one, the start of the sequence, or the end of everything so far", () => {
        expect(resolve('')).toBe(1);
        expect(resolve('<')).toBe(0);
        expect(resolve('a')).toBe(3);
        expect(resolve('a<+50%')).toBe(2);
        expect(resolve('<<+50%')).toBe(1.5);
        expect(resolve('>>-50%')).toBe(1.5);
    });

    it("adds every offset, including shares of the inserted entry's duration", () => {
        expect(resolve('a<+50%+=50%-1')).toBe(3);
        expect(resolve('>-=50%')).toBe(-1);
    });

    it("starts from the start of the sequence with no entry before", () => {
        expect(resolvePosition(parsePositionDescriptor('>+1' as At<never>), new Map(), 2)).toBe(1);
        expect(resolvePosition(parsePositionDescriptor('>>+50%' as At<never>), new Map(), 2)).toBe(0);
    });
});

describe("SequenceTimingBuilder", () => {
    const builder = () => SequenceTiming.builder().add(second, 'a');

    it("takes a transition together with its timing's options", () => {
        const timing = SequenceTiming.builder().add({duration: 1, delay: 0.5, repeat: 2}, 'a').build();
        expect(timing.entries[0].animation.playback).toEqual({delay: 0.5, repeat: 2});
        expect(timing.entries[0].animation.transition).toEqual({duration: 1});
    });

    it("rejects positions it can't parse, whose time isn't finite, or that refer to a later entry", () => {
        expect(() => SequenceTiming.builder().add(second, 'a', 'b>' as '>')).toThrow();
        expect(() => SequenceTiming.builder().add(second, 'a', Infinity)).toThrow(RangeError);
        expect(() => SequenceTiming.builder().add(second, 'a', '+Infinity' as '+0')).toThrow(RangeError);
    });

    it("rejects names used twice or with other characters", () => {
        expect(() => builder().add(second, 'a')).toThrow();
        expect(() => SequenceTiming.builder().add(second, 'a-b')).toThrow();
    });

    it("gives a new builder from every add, so branches don't share entries", () => {
        const trunk = builder();
        const branch = trunk.add(second, 'b');
        expect(namesOf(trunk.build())).toEqual(['a']);
        expect(namesOf(branch.build())).toEqual(['a', 'b']);
        expect(() => SequenceTiming.builder().build()).toThrow();
    });
});

describe("SequenceTiming", () => {
    it("can only be made by its builder", () => {
        expect(() => new (SequenceTiming as unknown as new (...args: unknown[]) => SequenceTiming)([], {})).toThrow("A SequenceTiming can only be created using SequenceTimingBuilder.");
        expect(() => new (SequenceTiming.builder().constructor as new () => unknown)()).toThrow("Use SequenceTiming.builder to create a SequenceTimingBuilder.");
    });

    it("names no class when it's built for production", () => {
        vi.stubEnv('NODE_ENV', 'production');
        try {
            expect(() => new (SequenceTiming as unknown as new (...args: unknown[]) => SequenceTiming)([], {})).toThrow("Illegal constructor");
            expect(() => new (SequenceTiming.builder().constructor as new () => unknown)()).toThrow("Illegal constructor");
        } finally {
            vi.unstubAllEnvs();
        }
    });
});

describe("positions", () => {
    const element = {} as Element;
    const startsOf = (timing: SequenceTiming, names: string[]) => {
        const mapping = Object.fromEntries(names.map(name => [name, [element, {opacity: 1}]]));
        const sequencePlan = plan(SequenceDefinition.of(timing, mapping as never), target => resolveTargets(target, element));
        return Object.fromEntries(names.map(name => [name, sequencePlan.entries.get(name)!.position]));
    };

    it("places entries after the end of everything so far", () => {
        const timing = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 2}), 'a')
            .add(second, 'b', 0)
            .add(second, 'c', '>>+0.5')
            .build();
        expect(startsOf(timing, ['a', 'b', 'c'])).toEqual({a: 0, b: 0, c: 2.5});
    });

    it("measures shares of the referenced entry, of everything so far, and of the inserted entry", () => {
        const timing = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 2}, {repeat: 1}), 'a')
            .add(second, 'b', 'a<+25%')
            .add(AnimationTiming.of({duration: 2}), 'c', '-=25%')
            .add(second, 'd', '>>-25%')
            .build();
        expect(startsOf(timing, ['a', 'b', 'c', 'd'])).toEqual({a: 0, b: 1, c: 1.5, d: 3});
    });

    it("starts the first entry from the start of the sequence, and clamps positions before it", () => {
        const timing = SequenceTiming.builder().add(second, 'a', '-50%').add(second, 'b', '<-1').build();
        expect(startsOf(timing, ['a', 'b'])).toEqual({a: 0, b: 0});
    });
});

describe("targets", () => {
    const [first, second] = [{} as Element, {} as Element];
    const scope = {} as Element;

    it("takes an element, or any iterable of them, directly or from a function, each element once", () => {
        expect(resolveTargets(first, scope)).toEqual([first]);
        expect(resolveTargets([first, second, first], scope)).toEqual([first, second]);
        expect(resolveTargets(new Set([second, first]), scope)).toEqual([second, first]);
        expect(resolveTargets(() => new Set([first]), scope)).toEqual([first]);
        expect(resolveTargets(() => second, scope)).toEqual([second]);
    });

    it("gives no elements for an empty target", () => {
        expect(resolveTargets([], scope)).toEqual([]);
    });
});

describe("TweenStops", () => {
    const stopsOf = (rawStops: Parameters<typeof TweenStops.of>[1]) => TweenStops.of('x', rawStops).stops.map(({offset, value}) => [offset, value]);

    it("reads one value or a single-value list as the last, and lists as spread evenly", () => {
        expect(stopsOf(5)).toEqual([[0, null], [1, 5]]);
        expect(stopsOf([5])).toEqual([[0, null], [1, 5]]);
        expect(stopsOf([0, 5, 10])).toEqual([[0, 0], [0.5, 5], [1, 10]]);
        expect(stopsOf({1: 2, 0.5: 1})).toEqual([[0, null], [0.5, 1], [1, 2]]);
    });

    it("takes the value underneath for a missing 0 or 1", () => {
        expect(stopsOf({0.5: 1})).toEqual([[0, null], [0.5, 1], [1, null]]);
        const stops = TweenStops.of('x', {0: 0, 0.5: 1});
        expect([stops.startValue, stops.endValue]).toEqual([0, null]);
        expect(TweenStops.of('x', 1).startValue).toBeNull();
    });

    it("keeps null at the ends, leaves it out between them, and rejects stops without values or outside 0–1", () => {
        expect(stopsOf([0, null])).toEqual([[0, 0], [1, null]]);
        expect(stopsOf([null, 1])).toEqual([[0, null], [1, 1]]);
        expect(stopsOf([0, null, 1])).toEqual([[0, 0], [1, 1]]);
        expect(() => stopsOf([])).toThrow(TypeError);
        expect(() => stopsOf([null])).toThrow(TypeError);
        expect(() => stopsOf({1.5: 1})).toThrow(RangeError);
    });

    it("gives the value at an offset only where there's a stop", () => {
        const stops = TweenStops.of('x', {0.25: '1px', 1: '2px'});
        expect(stops.get(0.25)).toBe('1px');
        expect(stops.get(0)).toBeNull();
        expect(stops.get(0.5)).toBeUndefined();
    });

    it("reverses into stops at 1 minus each offset, in order", () => {
        expect(TweenStops.of('x', {0: 0, 0.25: 5, 1: 10}).reverse().stops).toEqual([{offset: 0, value: 10}, {offset: 0.75, value: 5}, {offset: 1, value: 0}]);
        expect(TweenStops.of('x', 10).reverse().stops).toEqual([{offset: 0, value: 10}, {offset: 1, value: null}]);
    });
});

describe("animation", () => {
    it("checks the values' forms as it's made", () => {
        expect(() => animation('.card', {opacity: []}, {duration: 1})).toThrow(TypeError);
        expect(() => animation('.card', {opacity: {1.5: 1}}, {duration: 1})).toThrow(RangeError);
        const definition = animation('.card', {opacity: [0, 1]}, {duration: 1});
        expect(definition.target).toBe('.card');
        expect(definition.stopsByProperty.opacity!.stops).toEqual([{offset: 0, value: 0}, {offset: 1, value: 1}]);
    });
});

describe("sequence", () => {
    const fade = {duration: 1};

    it("names unnamed entries by their order, from a to z and on to aa", () => {
        let builder = sequence();
        for (let index = 0; index < 27; index++) builder = builder.add('.dot', {opacity: [0, 1]}, fade);
        const {timing, entries} = builder.build();
        expect(namesOf(timing).slice(0, 2)).toEqual(['a', 'b']);
        expect(namesOf(timing).slice(-2)).toEqual(['z', 'aa']);
        expect(entries.at(-1)).toMatchObject({name: 'aa', animation: {target: '.dot'}});
    });

    it("names unnamed entries around the names given", () => {
        const definition = sequence()
            .add('h1', {opacity: [0, 1]}, fade)
            .add('h2', {opacity: [0, 1]}, fade, {name: 'a'})
            .add('h3', {opacity: [0, 1]}, fade)
            .build();
        expect(namesOf(definition.timing)).toEqual(['b', 'a', 'c']);
    });

    it("takes definitions, named or not, and positions that refer to the names given", () => {
        const fadeIn = animation('.note', {opacity: [0, 1]}, fade);
        const nested = sequence().add('#cta', {scale: [0.8, 1]}, fade).build();
        const definition = sequence()
            .add('h1', {opacity: [0, 1]}, {...fade, delay: 0.1}, {name: 'title'})
            .add(fadeIn, {at: 'title<+0.2'})
            .add(nested, {name: 'cta', at: 'title>'})
            .build();
        const {timing, entries} = definition;
        expect(namesOf(timing)).toEqual(['title', 'a', 'cta']);
        expect(timing.entries[1]!.position).toEqual({reference: {kind: 'entry', name: 'title'}, anchor: 'start', offset: offset(0.2)});
        expect(entries.map(({name}) => name)).toEqual(['title', 'a', 'cta']);
        expect(entries[0]).toMatchObject({animation: {target: 'h1'}});
        expect(entries[1]).toEqual({name: 'a', animation: fadeIn});
        expect(entries[2]).toEqual({name: 'cta', sequence: nested});
    });

    it("can only be made by sequence or SequenceDefinition.of", () => {
        expect(() => new (SequenceDefinition as unknown as new (...args: unknown[]) => SequenceDefinition)([], SequenceTiming.builder().add(fade, 'a').build()))
            .toThrow("A SequenceDefinition can only be created using SequenceDefinitionBuilder or SequenceDefinition.of.");
        expect(() => new (sequence().constructor as new () => unknown)()).toThrow("Use sequence to create a SequenceDefinitionBuilder.");
    });

    it("names no class when it's built for production", () => {
        vi.stubEnv('NODE_ENV', 'production');
        try {
            expect(() => new (SequenceDefinition as unknown as new (...args: unknown[]) => SequenceDefinition)([], SequenceTiming.builder().add(fade, 'a').build()))
                .toThrow("Illegal constructor");
            expect(() => new (sequence().constructor as new () => unknown)()).toThrow("Illegal constructor");
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it("gives a new builder from every add", () => {
        const trunk = sequence().add('h1', {opacity: [0, 1]}, fade);
        trunk.add('h2', {opacity: [0, 1]}, fade);
        expect(namesOf(trunk.build().timing)).toEqual(['a']);
    });

    it("only lets positions refer to the names given before them, which its sequence timing checks as it's built", () => {
        // @ts-expect-error: no entry is named "title" yet.
        expect(() => sequence().add('h1', {opacity: [0, 1]}, fade, {at: 'title>'}).build()).toThrow();
        // @ts-expect-error: an unnamed entry can't be referred to.
        sequence().add('h1', {opacity: [0, 1]}, fade).add('h2', {opacity: [0, 1]}, fade, {at: 'a>'});
        expect(() => sequence().add('h1', {opacity: [0, 1]}, fade, {name: 'title'}).add('h2', {opacity: [0, 1]}, fade, {name: 'title'}).build()).toThrow();
        expect(() => sequence().build()).toThrow();
    });

    it("binds a sequence timing to a mapping of the same shape", () => {
        const inner = SequenceTiming.builder().add(fade, 'glow').build();
        const timing = SequenceTiming.builder().add(fade, 'title').add(inner, 'card').build();
        const definition = sequence(timing, {
            title: ['h1', {opacity: [0, 1]}],
            card: {glow: ['.card', {opacity: [0, 1]}]}
        });
        const [title, card] = definition.entries;
        expect(title).toMatchObject({name: 'title', animation: {target: 'h1', timing: timing.entries[0]!.animation}});
        expect((title as {animation: unknown}).animation).toBeInstanceOf(AnimationDefinition);
        expect(card).toMatchObject({name: 'card'});
        const {sequence: cardDefinition} = card as {sequence: SequenceDefinition};
        expect(cardDefinition).toBeInstanceOf(SequenceDefinition);
        expect(cardDefinition.timing).toBe(inner);
        expect(cardDefinition.entries).toMatchObject([{name: 'glow', animation: {target: '.card'}}]);
        expect(() => sequence(timing, {title: ['h1', {opacity: 1}]} as never)).toThrow('No mapping present for "card".');
        expect(() => sequence(timing, {title: ['h1', {opacity: 1}], card: {}} as never)).toThrow('No mapping present for "card>glow".');
        expect(() => sequence(timing, {title: {target: 'h1', values: {opacity: 1}}, card: {glow: ['.card', {opacity: 1}]}} as never))
            .toThrow('The mapping of "title" needs a target and values.');
        expect(() => sequence(timing, {title: ['h1', {opacity: []}], card: {glow: ['.card', {opacity: 1}]}})).toThrow(TypeError);
    });
});
