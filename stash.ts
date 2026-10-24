/**
 * Code and tests kept for reimplementing a sequence's playback options: its delay, its stagger, and its repeats.
 * Nothing compiles or runs this file. It was cut from `src/` and `tests/` as they stood when sequences lost their playback options,
 * so its imports and the names it uses are those of that time.
 */

// ─── Plan: src/resolution/plan.ts ───────────────────────────────────────────────────────────────────────────────

/*
 * A sequence's delay delays its entries' copies after its repeats: each target of an animation is a copy, and a subsequence is one copy as a whole.
 * A staggered sequence has no node of its own: its entries are planned once, as they'd be without the stagger, and the stagger only lives in their copies' delays.
 * The plan kept it as `parentDelay`, on each `StaggeredTarget` and on each `SequencePlan`, apart from an animation's own `delay`,
 * because the sequence's repeats sit between them: an animation's own delay is part of the sequence's iteration, while its parent's delays the copy after the repeats.
 */

/** Where a copy sits on a staggered sequence's stagger: a position among the `largest` count of any of its entries, from its index among its entry's `count`. */
export type StaggerAlign = (index: number, count: number, largest: number) => number;

/** The planners' steps for a sequence's delay: each planner took it after its position, and worked out where its copies move. */
abstract class EntryPlanner {
    #parentDelay: Seconds | Stagger = 0;

    /** Where its earliest copy first moves, delayed by its sequence, within that sequence's iteration; infinite when nothing in it moves. */
    earliestStart: Seconds = Infinity;
    /** Where its latest copy stops moving, delayed by its sequence, within that sequence's iteration; negative infinity when nothing in it moves. */
    latestEnd: Seconds = -Infinity;
    /** Where its latest copy stops moving, delayed by its sequence, when that sequence's iteration plays backwards, less the iteration's length; negative infinity when nothing in it moves. */
    latestFlippedEnd: Seconds = -Infinity;

    /** How many copies a staggered sequence makes of it. */
    abstract readonly copyCount: number;

    /** What the sequence it's in delays its copies by: a number delays them all, and a stagger each from its index among `copyCount`. */
    parentDelay(delay: Seconds | Stagger): this {
        this.#parentDelay = delay;
        return this;
    }

    protected parentDelayOf(copyIndex: number): Seconds {
        const parentDelay = this.#parentDelay;
        return typeof parentDelay === 'function' ? parentDelay(copyIndex, this.copyCount) : parentDelay;
    }
}

class AnimationPlanner extends EntryPlanner {
    get copyCount(): number {
        return this.targets.length;
    }

    /** Each target is a copy, which moves from its own delay for its plays; an infinite repeat counts its first play only. */
    override parentDelay(delay: Seconds | Stagger): this {
        super.parentDelay(delay);
        const parentDelays = this.targets.map((_, index) => this.parentDelayOf(index));
        const delayedStarts = parentDelays.map((parentDelay, index) => parentDelay + this.entryPosition + this.delays[index]!);
        const flippedEnds = parentDelays.map((parentDelay, index) => parentDelay - this.entryPosition - this.delays[index]!);
        this.earliestStart = Math.min(...delayedStarts);
        this.latestEnd = Math.max(...delayedStarts) + this.repeatedPlaysDuration;
        this.latestFlippedEnd = Math.max(...flippedEnds);
        return this;
    }
}

class SequencePlanner extends EntryPlanner {
    readonly copyCount = 1;

    /**
     * Positions each entry once, among the entries before it, then delays the entries' copies by the sequence's delay, sampled where each copy lines up when it's a stagger.
     * It ends where its last copy stops moving.
     */
    static of(definition: SequenceDefinition, resolveTargets: TargetsResolver): SequencePlanner {
        const {delay = 0, ...repeatOptions} = definition.timing.playback;

        const planners = new Map<string, EntryPlanner>();
        const entrySpans = new Map<string, EntrySpan>();
        definition.timing.entries.forEach(({name, position}, index) => {
            const planner = entryPlannerOf(definition.entries[index]!, resolveTargets).position(position, entrySpans);
            planners.set(name, planner);
            entrySpans.set(name, planner.span);
        });

        const entryDelay = typeof delay === 'function' ? staggeredDelayOf(delay, [...planners.values()].map(planner => planner.copyCount)) : delay;
        const entries = new Map([...planners].map(([name, planner]) => [name, planner.parentDelay(entryDelay).plan()]));

        const playDuration = Math.max(0, ...[...entrySpans.values()].map(({start, duration}) => start + duration));
        const entryPlanners = [...planners.values()];
        const anchorDuration = Math.max(0, motionEndOf(entryPlanners, playDuration, repeatOptions));
        const earliestStart = Math.min(...entryPlanners.map(planner => planner.earliestStart));
        const firstMotionStart = earliestStart === Infinity ? undefined : earliestStart;

        return new SequencePlanner(definition, entries, playDuration, anchorDuration, firstMotionStart);
    }

    /** It's one copy, which moves from its first motion until its anchor duration ends; none when nothing in it moves. */
    override parentDelay(delay: Seconds | Stagger): this {
        super.parentDelay(delay);
        if (this.firstMotionStart === undefined) return this;
        const parentDelay = this.parentDelayOf(0);
        const motionStart = this.entryPosition + this.firstMotionStart;
        this.earliestStart = parentDelay + motionStart;
        this.latestEnd = parentDelay + this.entryPosition + this.anchorDuration;
        this.latestFlippedEnd = parentDelay - motionStart;
        return this;
    }
}

/** The stagger sampled where each copy sits among the largest of the entries' copy counts, which may be between two copies. */
function staggeredDelayOf(stagger: Stagger, copyCounts: readonly number[]): Stagger {
    const largest = Math.max(...copyCounts);
    const staggerAlign = defaultStaggerAlignOf(stagger);
    return (index, count) => stagger(clamp(staggerAlign(index, count, largest), 0, largest - 1), largest);
}

/** Lines up the share of an entry's copies that the stagger's origin is at with the same share of the largest count; the first copies line up when it has none. */
function defaultStaggerAlignOf({from}: Stagger): StaggerAlign {
    const share = from === 'center' ? 0.5 : from === 'last' ? 1 : 0;
    return (index, count, largest) => index + share * (largest - count);
}

/**
 * Where a sequence's latest copy stops moving: after the earlier iterations and their repeat delays, at the latest end in the last iteration,
 * or, when that iteration plays backwards, at the latest flipped end; an infinite repeat counts its first iteration only.
 */
function motionEndOf(entryPlanners: readonly EntryPlanner[], iterationDuration: Seconds, {repeat = 0, repeatDelay = 0, repeatMode = 'loop'}: RepeatOptions): Seconds {
    const latestEnd = Math.max(...entryPlanners.map(planner => planner.latestEnd));
    if (repeat === Infinity) return latestEnd;
    const lastPlaysBackwards = repeatMode !== 'loop' && repeat % 2 === 1;
    const lastIterationEnd = lastPlaysBackwards ? iterationDuration + Math.max(...entryPlanners.map(planner => planner.latestFlippedEnd)) : latestEnd;
    return repeat * (iterationDuration + repeatDelay) + lastIterationEnd;
}

// ─── Tracks: src/waapi/tracks.ts ────────────────────────────────────────────────────────────────────────────────

/*
 * Only the outermost repeat ran as WAAPI iterations: every repeat inside it was baked into the runs, and an infinite one inside it kept its first iteration,
 * with a continuing effect from there, ordered at the part index −(depth + 1) so continuations deeper came before shallower ones, and all before what covers them.
 */

/** Plays that the sequences around them haven't repeated yet. */
interface KeyedRun extends TrackKey {
    run: TrackRun;
}

/** What an entry puts on the tracks, in the time of the iteration of the sequence it's in. */
interface Contribution {
    runs: KeyedRun[];
    effects: ScheduledEffect[];
}

class AnimationTracksResolver {
    private static scheduleRepetitions(plan: PlanNode, path: EntryPath | undefined, order: readonly number[], repeatingAncestor: boolean): Contribution {
        switch (plan.type) {
            case 'animation':
                return AnimationTracksResolver.resolveAnimationRepetitions(plan, path, order, repeatingAncestor);
            case 'sequence':
                return AnimationTracksResolver.resolveSequenceRepetitions(plan, path, order, repeatingAncestor);
        }
    }

    private static resolveAnimationRepetitions(plan: AnimationPlan, path: EntryPath | undefined, order: readonly number[], repeatingAncestor: boolean): Contribution {
        const {definition, easing, playDuration} = plan;
        const runs = plan.targets.flatMap(({target}) => Object.entries(definition.stopsByProperty).map(([property, stops]): KeyedRun =>
            ({element: target, property, path, entryStops: stops, order, run: TrackRun.play(playDuration, easing, stops)})
        ));
        const repeated = AnimationTracksResolver.repeated({runs, effects: []}, playDuration, definition.timing.playback, repeatingAncestor, order.length);
        const delays = new Map(plan.targets.map(({target, delay}) => [target, delay]));
        return AnimationTracksResolver.shifted(repeated, ({element}) => plan.position + delays.get(element)!);
    }

    private static resolveSequenceRepetitions(plan: SequencePlan, path: EntryPath | undefined, order: readonly number[], repeatingAncestor: boolean): Contribution {
        const {playback} = plan.definition.timing;
        const repeats = (playback.repeat ?? 0) > 0;
        const children: Contribution = {runs: [], effects: []};
        [...plan.entries].forEach(([name, entryPlan], index) => {
            const child = AnimationTracksResolver.scheduleRepetitions(entryPlan, entryPathOf(path, name), [...order, index], repeatingAncestor || repeats);
            const repeated = AnimationTracksResolver.repeated(child, plan.playDuration, playback, repeatingAncestor, order.length);
            const copyDelayed = AnimationTracksResolver.shifted(repeated, copyDelayOf(entryPlan));
            children.runs.push(...copyDelayed.runs);
            children.effects.push(...copyDelayed.effects);
        });
        return AnimationTracksResolver.shifted(children, () => plan.position);
    }

    /**
     * Repeats the runs within iterations of `iterationDuration`: as WAAPI iterations when nothing around repeats, baked into the runs otherwise.
     * An infinite repeat inside another keeps its first iteration and continues in an effect of its own, declared before the runs so that they show over it.
     */
    private static repeated({runs, effects}: Contribution, iterationDuration: Seconds, options: RepeatOptions, repeatingAncestor: boolean, depth: number): Contribution {
        const repeatCount = options.repeat ?? 0;
        if (!repeatingAncestor) {
            const repeatedEffects = runs.flatMap(({run, ...key}) => nativelyRepeated(run, iterationDuration, options)
                .map((timing, index): ScheduledEffect => ({...key, order: [...key.order, index], ...timing}))
            );
            return {runs: [], effects: [...effects, ...repeatedEffects]};
        }

        if (repeatCount === 0) return {runs, effects};

        if (!Number.isFinite(repeatCount)) {
            const continuingEffects = runs.map(({run, ...key}): ScheduledEffect =>
                ({...key, order: [...key.order, -(depth + 1)], ...continued(run, iterationDuration, options)})
            );
            return {runs, effects: [...effects, ...continuingEffects]};
        }

        return {runs: runs.map(keyed => ({...keyed, run: baked(keyed.run, iterationDuration, options)})), effects};
    }

    /** Moves each run and effect later by `startOf` its track. */
    private static shifted({runs, effects}: Contribution, startOf: (key: TrackKey) => Seconds): Contribution {
        return {
            runs: runs.map(keyed => ({...keyed, run: keyed.run.shifted(startOf(keyed))})),
            effects: effects.map(effect => ({...effect, delay: effect.delay + startOf(effect)}))
        };
    }
}

/** What its sequence delays each copy of the entry by, after the sequence's repeats: each element of an animation, or a subsequence as a whole. */
function copyDelayOf(plan: PlanNode): (key: TrackKey) => Seconds {
    if (plan.type === 'sequence') return () => plan.parentDelay;
    const parentDelays = new Map(plan.targets.map(({target, parentDelay}) => [target, parentDelay]));
    return ({element}) => parentDelays.get(element)!;
}

/** Every iteration of a finite repeat in the run, one after another. */
function baked(run: TrackRun, iterationDuration: Seconds, options: RepeatOptions): TrackRun {
    const playCount = (options.repeat ?? 0) + 1;
    return TrackRun.joined(Array.from({length: playCount}, (_, index) => run.iteration(index, iterationDuration, options)));
}

/**
 * An infinite repeat after its first iteration, from the moment that iteration ends:
 * [hold, run] × ∞, or [hold, flipped, hold, run] × ∞ for a reverse or a mirror.
 */
function continued(run: TrackRun, iterationDuration: Seconds, options: RepeatOptions): EffectTiming {
    const iteration = (index: number) => run.iteration(index, iterationDuration, options);
    const iterations = options.repeatMode === 'loop' || options.repeatMode === undefined ? [iteration(1)] : [iteration(1), iteration(2)];
    return timingOf(TrackRun.joined(iterations).heldFrom(run.end, run.endValue), Infinity);
}

// ─── Track runs: src/resolution/track-runs.ts ───────────────────────────────────────────────────────────────────

class TrackRun {
    /** Holds `value` from `time` until the run starts. */
    heldFrom(time: Seconds, value: CSSValue | null): TrackRun {
        return new TrackRun([...holdSpans(value, time, this.start), ...this.spans]);
    }
}

// ─── Tests: tests/tracks.test.ts, with its helpers ──────────────────────────────────────────────────────────────

describe("plans", () => {
    const threeElements = [{} as Element, {} as Element, {} as Element];

    it("refers to an entry's start before its delay, and repeats the sequence's iteration", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}), 'a')
            .add(AnimationTiming.of({duration: 2}, {delay: 0.25}), 'b', '+0.5')
            .add(AnimationTiming.of({duration: 1}), 'c', 'b<+0')
            .build({delay: 1, repeat: 1, repeatDelay: 0.5});
        const sequencePlan = sequencePlanOf(sequence, {a: line, b: line, c: line});
        expect(sequencePlan.entries.get('b')).toMatchObject({position: 1.5});
        expect(sequencePlan.entries.get('c')).toMatchObject({position: 1.5});
        expect(sequencePlan).toMatchObject({position: 0, playDuration: 3.75});
        expect(sequenceEndOf(sequence, {a: line, b: line, c: line})).toBe(9);
    });

    it("counts the first play of an infinite entry", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}, {repeat: Infinity}), 'a')
            .build({repeat: 1});
        expect(sequencePlanOf(sequence, {a: line})).toMatchObject({playDuration: 1});
        expect(sequenceEndOf(sequence, {a: line})).toBe(2);
    });

    it("leaves what a sequence's stagger delays its entries by out of their durations, and ends the sequence where its last copy's motion stops", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}), 'cards')
            .add(AnimationTiming.of({duration: 4}), 'title', 0)
            .add(AnimationTiming.of({duration: 1}), 'after', 'cards>')
            .build({delay: index => index * 0.5});
        const sequencePlan = sequencePlanOf(sequence, {cards: line, title: line, after: line}, {cards: threeElements});
        expect(sequencePlan.entries.get('cards')).toMatchObject({position: 0});
        expect(sequencePlan.entries.get('after')).toMatchObject({position: 1});
        expect(sequencePlan).toMatchObject({playDuration: 4});
        expect(sequenceEndOf(sequence, {cards: line, title: line, after: line}, {cards: threeElements})).toBe(4);
    });

    it("ends a sequence whose last iteration plays backwards where its earliest motion started", () => {
        const builder = SequenceTiming.builder().add(AnimationTiming.of({duration: 1}), 'a', '+1');
        const endRepeating = (repeatMode: RepeatMode) => sequenceEndOf(builder.build({repeat: 1, repeatMode}), {a: line});
        expect(sequencePlanOf(builder.build({repeat: 1, repeatMode: 'reverse'}), {a: line})).toMatchObject({playDuration: 2});
        expect(endRepeating('loop')).toBe(4);
        expect(endRepeating('reverse')).toBe(3);
    });
});

describe("AnimationTracksResolver sequence values", () => {
    const position = 0.2;
    const sequenceRepeat = {repeat: 3, repeatDelay: 0.3} as const;

    for (const [name, transition, tolerance] of transitions) {
        it(`follows ${name} through a sequence's loops and reverses, with the entry's own repeats baked in`, () => {
            const entryRepeat = {repeat: 1, repeatDelay: 0.25, repeatMode: 'reverse'} as const;
            for (const repeatMode of ['loop', 'reverse'] as const) {
                const timing = AnimationTiming.of(transition, entryRepeat);
                const {duration, easing} = resolveTransition(timing.transition);
                const sequence = SequenceTiming.builder()
                    .add(timing, 'a', position)
                    .add(AnimationTiming.of({duration: 1.5}), 'b', 0)
                    .build({...sequenceRepeat, repeatMode});
                const effects = sequenceTracksOf(sequence, {a: valuesWithStop, b: {y: line.x}}).get(element)!.x!;
                const iterationDuration = position + 2 * duration + entryRepeat.repeatDelay;
                const entryValueAt = (time: number) =>
                    definedValueAt(easing, stopsWithStop, duration, entryRepeat, Math.max(time - position, 0));
                const definedAt = (time: number) => {
                    const iteration = Math.min(Math.floor(time / (iterationDuration + sequenceRepeat.repeatDelay)), sequenceRepeat.repeat);
                    const local = Math.min(time - iteration * (iterationDuration + sequenceRepeat.repeatDelay), iterationDuration);
                    return entryValueAt(repeatMode === 'reverse' && iteration % 2 === 1 ? iterationDuration - local : local);
                };
                expectTrackToFollow(effects, definedAt, tolerance, 12, repeatMode);
            }
        });

        it(`follows ${name} through a sequence's mirrors, its easing running forwards`, () => {
            const timing = AnimationTiming.of(transition);
            const {duration, easing} = resolveTransition(timing.transition);
            const sequence = SequenceTiming.builder()
                .add(timing, 'a', position)
                .build({...sequenceRepeat, repeatMode: 'mirror'});
            const effects = sequenceTracksOf(sequence, {a: valuesWithStop}).get(element)!.x!;
            const iterationDuration = position + duration;
            const definedAt = (time: number) => {
                const iteration = Math.min(Math.floor(time / (iterationDuration + sequenceRepeat.repeatDelay)), sequenceRepeat.repeat);
                const local = Math.min(time - iteration * (iterationDuration + sequenceRepeat.repeatDelay), iterationDuration);
                if (iteration % 2 === 0) return stopsWithStop.valueAt(easedProgressAt(easing, (local - position) / duration));
                const playedBack = (iterationDuration - local - position) / duration;
                return reversedOf(stopsWithStop).valueAt(easedProgressAt(easing, 1 - playedBack));
            };
            expectTrackToFollow(effects, definedAt, tolerance, 6);
        });
    }
});
describe("AnimationTracksResolver sequences", () => {
    const sample = (effects: readonly NativeAnimationEffect[], times: number[]) => times.map(time => trackValueAt(effects, time));

    it("repeats the outermost repeating sequence natively, holding each entry through the rest of the iteration", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}), 'a')
            .add(AnimationTiming.of({duration: 1}), 'b')
            .build({repeat: 2, repeatDelay: 0.5});
        const tracks = sequenceTracksOf(sequence, {a: {x: line.x}, b: {y: line.x}}).get(element)!;
        expect(tracks.x!.map(timingOf)).toEqual([
            {delay: 0, duration: 2.5, iterations: 2, direction: 'normal', fill: 'both'},
            {delay: 5, duration: 1, iterations: 1, direction: 'normal', fill: 'forwards'}
        ]);
        expect(tracks.y!.map(timingOf)).toEqual([
            {delay: 1, duration: 2.5, iterations: 2, direction: 'normal', fill: 'both'},
            {delay: 6, duration: 1, iterations: 1, direction: 'normal', fill: 'forwards'}
        ]);
        expect(sample(tracks.y!, [0.5, 1.5, 3, 4, 7.5])).toEqual(closeTo([[0, 0.5, 1, 0.5, 1]])[0]);
    });

    it("reverses a sequence's iteration in time", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}), 'a')
            .add(AnimationTiming.of({duration: 1}), 'b', '+0')
            .build({repeat: 1, repeatDelay: 0.5, repeatMode: 'reverse'});
        const effects = sequenceTracksOf(sequence, {a: {x: line.x}, b: {y: line.x}}).get(element)!.x!;
        expect(effects.map(timingOf)).toEqual([{delay: 0, duration: 4.5, iterations: 1, direction: 'normal', fill: 'both'}]);
        expect(sample(effects, [0.5, 2, 3.75, 4.25, 5])).toEqual(closeTo([[0.5, 1, 0.75, 0.25, 0]])[0]);
    });

    it("bakes the repeats inside the outermost one", () => {
        const nested = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1, easing: 'easeIn'}), 'a')
            .build({repeat: 1, repeatDelay: 0.5, repeatMode: 'mirror'});
        const sequence = SequenceTiming.builder().add(nested, 'nested').build({repeat: 1});
        const effects = sequenceTracksOf(sequence, {'nested>a': {x: line.x}}).get(element)!.x!;
        expect(effects.map(timingOf)).toEqual([{delay: 0, duration: 2.5, iterations: 2, direction: 'normal', fill: 'both'}]);

        const easeIn = resolveEasing('easeIn');
        expect(sample(effects, [0.5, 1.25, 2, 3, 4.5])).toEqual(closeTo([[easeIn.progressAt(0.5), 1, 1 - easeIn.progressAt(0.5), easeIn.progressAt(0.5), 1 - easeIn.progressAt(0.5)]])[0]);
    });

    it("continues an infinite entry in a finitely repeating sequence after its first play, under the sequence's effects", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}, {repeat: Infinity, repeatDelay: 0.5}), 'a')
            .add(AnimationTiming.of({duration: 1}), 'b', '+0')
            .build({repeat: 1});
        const effects = sequenceTracksOf(sequence, {a: {x: line.x}, b: {y: line.x}}).get(element)!.x!;
        expect(effects.map(timingOf)).toEqual([
            {delay: 1, duration: 1.5, iterations: Infinity, direction: 'normal', fill: 'forwards'},
            {delay: 0, duration: 2, iterations: 1, direction: 'normal', fill: 'backwards'},
            {delay: 2, duration: 1, iterations: 1, direction: 'normal', fill: 'none'}
        ]);
        expect(sample(effects, [0.5, 1.5, 2.5, 3.25, 4, 4.75])).toEqual(closeTo([[0.5, 1, 0.5, 0.25, 1, 0.25]])[0]);
    });

    it("drops an infinite entry's continuation in an infinitely repeating sequence", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}, {repeat: Infinity, repeatDelay: 0.5}), 'a')
            .build({repeat: Infinity});
        expect(sequenceTracksOf(sequence, {a: {x: line.x}}).get(element)!.x!.map(timingOf))
            .toEqual([{delay: 0, duration: 1, iterations: Infinity, direction: 'normal', fill: 'both'}]);
    });
});

describe("AnimationTracksResolver staggered sequences", () => {
    const cards = [{} as Element, {} as Element, {} as Element];
    const icons = [{} as Element, {} as Element, {} as Element];
    const startsOf = (tracks: AnimationTracks, elements: Element[], property: string) =>
        elements.map(element => tracks.get(element)![property]![0]!.delay);

    it("plays the sequence once per element index, chaining each copy's entries on their own", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}), 'lift')
            .add(AnimationTiming.of({duration: 1}), 'glow')
            .build({delay: index => index * 0.25});
        const tracks = sequenceTracksOf(sequence, {lift: {x: line.x}, glow: {y: line.x}}, {lift: cards, glow: icons});
        expect(startsOf(tracks, cards, 'x')).toEqual([0, 0.25, 0.5]);
        expect(startsOf(tracks, icons, 'y')).toEqual([1, 1.25, 1.5]);
    });

    it("plays every copy's entries where they'd be without the sequence's stagger, so an entry's own stagger pushes the next entry on in every copy", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}, {delay: index => index * 0.5}), 'lift')
            .add(AnimationTiming.of({duration: 1}), 'glow')
            .build({delay: index => index * 0.25});
        const tracks = sequenceTracksOf(sequence, {lift: {x: line.x}, glow: {y: line.x}}, {lift: cards, glow: icons});
        expect(startsOf(tracks, cards, 'x')).toEqual([0, 0.75, 1.5]);
        expect(startsOf(tracks, icons, 'y')).toEqual([2, 2.25, 2.5]);
    });

    it("repeats every copy with the same iteration, from its own delay", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}, {delay: index => index * 0.5}), 'lift')
            .add(AnimationTiming.of({duration: 1}), 'glow')
            .build({delay: index => index * 0.25, repeat: 1});
        const tracks = sequenceTracksOf(sequence, {lift: {x: line.x}, glow: {y: line.x}}, {lift: cards, glow: icons});
        expect(cards.map(card => tracks.get(card)!.x!.map(({delay}) => delay))).toEqual([[0, 3], [0.75, 3.75], [1.5, 4.5]]);
    });

    it("lines up the first elements of animations with fewer elements, without a stagger origin", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}), 'lift')
            .add(AnimationTiming.of({duration: 1}), 'glow')
            .build({delay: index => index * 0.25});
        const tracks = sequenceTracksOf(sequence, {lift: {x: line.x}, glow: {y: line.x}}, {lift: cards, glow: icons.slice(0, 2)});
        expect(startsOf(tracks, icons.slice(0, 2), 'y')).toEqual([1, 1.25]);
    });

    it("lines up the share of the elements at the stagger's origin, sampling the stagger between two elements", () => {
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}), 'lift')
            .add(AnimationTiming.of({duration: 1}), 'glow')
            .build({delay: stagger(0.1, {from: 'center'})});
        const fourCards = [...cards, {} as Element];
        const tracks = sequenceTracksOf(sequence, {lift: {x: line.x}, glow: {y: line.x}}, {lift: fourCards, glow: icons});
        expect(startsOf(tracks, fourCards, 'x')).toEqual([0.15, 0.05, 0.05, 0.15].map(delay => expect.closeTo(delay, 9)));
        expect(startsOf(tracks, icons, 'y')).toEqual([1.1, 1, 1.1].map(delay => expect.closeTo(delay, 9)));

        const fromLast = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}), 'lift')
            .add(AnimationTiming.of({duration: 1}), 'glow')
            .build({delay: stagger(0.1, {from: 'last'})});
        const lastTracks = sequenceTracksOf(fromLast, {lift: {x: line.x}, glow: {y: line.x}}, {lift: cards, glow: icons.slice(0, 1)});
        expect(startsOf(lastTracks, icons.slice(0, 1), 'y')).toEqual([1]);
    });
    it("delays a subsequence as one copy, and leaves its elements to its own stagger", () => {
        const details = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}), 'glow')
            .build({delay: index => index * 0.1});
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}), 'lift')
            .add(details, 'details')
            .build({delay: index => 0.5 - index * 0.25});
        const tracks = sequenceTracksOf(sequence, {lift: {x: line.x}, 'details>glow': {y: line.x}}, {lift: cards, 'details>glow': icons});
        expect(startsOf(tracks, cards, 'x')).toEqual([0.5, 0.25, 0]);
        expect(startsOf(tracks, icons, 'y')).toEqual([1.5, 1.6, 1.7]);
    });

    it("counts a subsequence as one copy toward the largest count", () => {
        const details = SequenceTiming.builder().add(AnimationTiming.of({duration: 1}), 'glow').build();
        const sequence = SequenceTiming.builder()
            .add(AnimationTiming.of({duration: 1}), 'title')
            .add(details, 'details', 0)
            .build({delay: (_index, total) => total * 0.5});
        const tracks = sequenceTracksOf(sequence, {title: {x: line.x}, 'details>glow': {y: line.x}}, {'details>glow': icons});
        expect(startsOf(tracks, [element], 'x')).toEqual([0.5]);
        expect(startsOf(tracks, icons, 'y')).toEqual([0.5, 0.5, 0.5]);
    });
});

// ─── Tests: tests/sequence.test.ts ──────────────────────────────────────────────────────────────────────────────

describe("SequenceTimingBuilder", () => {
    const builder = () => SequenceTiming.builder().add(second, 'a');

    it("rejects time fields that aren't finite and a repeat count that isn't a number", () => {
        expect(() => builder().build({delay: Infinity})).toThrow(RangeError);
        expect(() => builder().build({repeatDelay: NaN})).toThrow(RangeError);
        expect(() => builder().build({repeat: NaN})).toThrow(RangeError);
    });

    it("clamps negative delays and repeats to 0 and rounds fractional repeat counts down", () => {
        expect(builder().build({delay: -3, repeat: -2.5, repeatDelay: -1}).playback).toEqual({delay: 0, repeat: 0, repeatDelay: 0});
        expect(builder().build({repeat: 2.7}).playback.repeat).toBe(2);
    });
});
