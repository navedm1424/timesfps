import type {Easing} from "../easing.ts";
import type {RepeatOptions} from "../playback-options.ts";
import type {EntryPath, Naming} from "../naming.ts";
import type {TweenStops} from "../tween-stops.ts";
import type {Seconds} from "../types.ts";
import {getOrInsert, groupBy, popWhile, shiftWhile} from "../utils/collections.ts";
import type {AnimationPlan, PlanNode, SequencePlan} from "./plan.ts";
import {assign, isOpen, type PendingValue, repeatsForever, TrackEntryBuilder} from "./track-entry-builder.ts";
import {TrackRun, TrackStops} from "./track-runs.ts";
import {currentValueToken, type TrackValue} from "./track-values.ts";

/** A sequence that entries are in: where it starts, how long an iteration of it lasts, and how it repeats. */
export interface ParentContext {
    /** When it starts after the outermost definition starts. */
    start: Seconds;
    /** How long one play of it lasts, without repeats. */
    duration: Seconds;
    repeatOptions: RepeatOptions;
}

/** Holds the value at the end it's on, forever. */
export interface HoldExtrapolation {
    type: 'hold';
}

/** Lengths are fractions of the entry's duration. */
interface RepeatExtrapolation {
    /** How many more times it plays after its first play; `Infinity` repeats forever. */
    iterations: number;
    /** How long it holds before each repeat. */
    pause: number;
    /** Whether it holds the value it ends on once it's done. */
    holdsAfter: boolean;
}

export interface LoopExtrapolation extends RepeatExtrapolation {
    type: 'loop';
}

/** Every other play flips: in time, so it plays backwards, or in values, so it runs from the end values to the start ones with its easing forwards. */
export interface OscillateExtrapolation extends RepeatExtrapolation {
    type: 'oscillate';
    flip: 'time' | 'values';
}

export type Extrapolation = HoldExtrapolation | LoopExtrapolation | OscillateExtrapolation;

/** A range on a track: its keyed run, within 0 to `duration`, `start` after the outermost definition starts, and what it shows before and after it. */
export interface TrackEntry {
    name: string | undefined;
    start: Seconds;
    duration: Seconds;
    keyedRun: TrackRun<TrackValue>;
    preExtrapolation?: HoldExtrapolation;
    postExtrapolation?: Extrapolation;
}

/** Its entries in the order they show over each other in: by when they start, then in the order they're declared; a merged entry's copies of what repeats forever come right under it. */
export type Track = readonly TrackEntry[];

/** An animation leaf's play of one property on one target. */
interface TrackBuilderEntry {
    path: EntryPath | undefined;
    /** After the outermost definition starts. */
    start: Seconds;
    duration: Seconds;
    easing: Easing;
    stops: TweenStops;
    repeatOptions: RepeatOptions;
    /** The contexts of the sequences around it, the outermost first. */
    ancestors: readonly ParentContext[];
    /** The sequences around it that repeat, the outermost first. */
    repeatingAncestors: readonly ParentContext[];
}

/** Each target's tracks by property: what every animation leaf plays on it, laid out in time. */
export class Tracks {
    constructor(readonly byTarget: ReadonlyMap<Element, { readonly [property: string]: Track }>) {}
}

/** Lays its plan out in tracks, naming their entries by `naming`. */
export class TracksResolver {
    private readonly buildersByTarget = new Map<Element, { [property: string]: TrackBuilder }>();

    constructor(private readonly plan: PlanNode, private readonly naming: Naming) {}

    /** Adds every animation leaf of the plan to its targets' track builders, then builds them. */
    resolve(): Tracks {
        const {plan} = this;
        if (plan.type === 'sequence')
            this.addSequence(plan, [{start: plan.position, duration: plan.playDuration, repeatOptions: {}}]);
        else
            this.addAnimation(plan);

        return new Tracks(new Map([...this.buildersByTarget].map(([target, buildersByProperty]) => [target, Object.fromEntries(
            Object.entries(buildersByProperty).map(([property, builder]) => [property, builder.build()])
        )])));
    }

    /** Adds its entries in their order, with the contexts of the sequences around them, the outermost first: a subsequence's entries with its own after those. */
    private addSequence(plan: SequencePlan, ancestors: readonly ParentContext[], path?: EntryPath): void {
        const sequenceStart = ancestors.at(-1)!.start;
        for (const [name, entryPlan] of plan.entries) {
            const entryPath = this.naming.entryPathOf(path, name);
            if (entryPlan.type === 'sequence') {
                const subsequenceContext = {start: sequenceStart + entryPlan.position, duration: entryPlan.playDuration, repeatOptions: {}};
                this.addSequence(entryPlan, [...ancestors, subsequenceContext], entryPath);
            } else
                this.addAnimation(entryPlan, ancestors, entryPath);
        }
    }

    /** Adds a play of each property on each target, after the start of the sequence it's in, its own position, and the target's delay. */
    private addAnimation({definition, easing, playDuration, position, targets}: AnimationPlan, ancestors: readonly ParentContext[] = [], path?: EntryPath): void {
        const sequenceStart = ancestors.at(-1)?.start ?? 0;
        for (const {target, delay} of targets) {
            for (const [property, stops] of Object.entries(definition.stopsByProperty)) {
                this.trackBuilderOf(target, property).add({
                    path, start: sequenceStart + position + delay, duration: playDuration, easing, stops, repeatOptions: definition.timing.playback, ancestors
                });
            }
        }
    }

    private trackBuilderOf(target: Element, property: string): TrackBuilder {
        const buildersByProperty = getOrInsert(this.buildersByTarget, target, () => ({}));
        return buildersByProperty[property] ??= new TrackBuilder(this.naming);
    }
}

/** The entries that animate one property of one target, built into its track once they're all added. */
class TrackBuilder {
    /** In the order they're added; an entry already built into a builder is null. */
    private readonly entries: (TrackBuilderEntry | null)[] = [];
    /** The indexes of the entries in each outermost repeating sequence, in the order they're added. */
    private readonly entryIndexesByRepeatingAncestor = new Map<ParentContext, number[]>();

    constructor(private readonly naming: Naming) {}

    add(entry: Omit<TrackBuilderEntry, 'repeatingAncestors'>): void {
        const repeatingAncestors = entry.ancestors.filter(isRepeating);
        const [repeatingAncestor] = repeatingAncestors;
        if (repeatingAncestor) getOrInsert(this.entryIndexesByRepeatingAncestor, repeatingAncestor, () => []).push(this.entries.length);
        this.entries.push({...entry, repeatingAncestors});
    }

    /**
     * Builds a track entry for each entry no sequence around repeats, with its own repeats,
     * and one for each outermost repeating sequence, its entries merged into it, that repeats as the sequence does, over copies of what in it repeats forever.
     * Lays them out over each other in stacking order, in one walk, and leaves out the ones that never show.
     * - A missing start takes the value of the one under it there. With none under it, it takes the end value of the one that ended last,
     *   and when that one's end is missing too, both are the current value. With none before it, it's the current value.
     * - A missing end takes the value of the one under it there that ends after it. With none, it waits for the next one that starts once it has ended, and takes its start.
     * - The ones under it that end with or before it never show again, and the ones that start with it never show at all.
     * - It holds after it ends when nothing under it runs on after that, and before it starts when it's among the ones that start first.
     * - The copies under a merged one have its values, and take none of their own.
     */
    build(): Track {
        const {entries} = this;
        const indexesInStackingOrder = Array.from(entries.keys()).sort((first, second) => byStart(entries[first]!, entries[second]!));
        let firstStart: Seconds | undefined;
        /** The ones that show at the latest start, each over the ones that end after it. */
        const runStack: TrackEntryBuilder[] = [];
        /** The ones whose missing end waits for a start, in the order they end. */
        const pending: TrackEntryBuilder[] = [];
        /** The ones that show, in the order they show over each other in. */
        const shown = new Set<TrackEntryBuilder>();
        /** Pops the ones that end by `time`, and leaves out the ones among them that start with `builder`. */
        const popEndedBy = (time: Seconds, builder: TrackEntryBuilder): TrackEntryBuilder[] => {
            const popped = popWhile(runStack, run => run.end <= time);
            for (const run of popped.filter(run => run.start === builder.start)) shown.delete(run);
            return popped;
        };

        for (const index of indexesInStackingOrder) {
            const entry = entries[index];
            if (!entry) continue;
            const [repeatingAncestor] = entry.repeatingAncestors;
            const group = repeatingAncestor ? this.takeEntriesAt(this.entryIndexesByRepeatingAncestor.get(repeatingAncestor)!).toSorted(byStart) : [entry];
            const builders = this.buildersOf(group);
            const copies = [...builders].filter(([member]) => isContinuedByCopy(member, group)).map(([, copy]) => copy).toSorted(byStart);
            const builder = builders.get(repeatingAncestor ?? entry)!;
            firstStart ??= builder.start;

            const previous = popEndedBy(builder.start, builder).at(-1);
            const under = runStack.at(-1);
            if (under)
                builder.assignStartInterpolation(under);
            else if (previous?.hasOpenEnd && builder.hasOpenStart) {
                builder.assignStartCurrentValue();
                previous.assignEndCurrentValue();
            } else if (previous)
                builder.assignStartInterpolation(previous);
            else
                builder.assignStartCurrentValue();

            for (const ended of shiftWhile(pending, run => run.end <= builder.start))
                ended.assignEndInterpolation(builder);

            runStack.push(...copies);
            popEndedBy(builder.end, builder);
            const landing = runStack.at(-1);
            if (landing)
                builder.assignEndInterpolation(landing);
            else {
                builder.holdAfter();
                if (builder.hasOpenEnd)
                    pending.push(builder);
            }
            if (builder.start === firstStart)
                builder.holdBefore();

            runStack.push(builder);
            for (const copy of copies) shown.add(copy);
            shown.add(builder);
        }
        return [...shown].map(builder => builder.build());
    }

    /** Takes the entries at the indexes out of the entries, leaving null in their place. */
    private takeEntriesAt(indexes: readonly number[]): TrackBuilderEntry[] {
        const taken = indexes.map(index => this.entries[index]!);
        for (const index of indexes) this.entries[index] = null;
        return taken;
    }

    /** The builder of an entry's play, with its own repeats. */
    private playOf(entry: TrackBuilderEntry): TrackEntryBuilder {
        return TrackEntryBuilder.play(this.naming.trackEntryNameOf(entry.path), entry, entry.easing, new TrackStops(entry.stops.stops));
    }

    /** The builders of the entries, in stacking order, and of each repeating sequence they're in, the innermost ones first. */
    private buildersOf(entries: readonly TrackBuilderEntry[]): Map<TrackBuilderEntry | ParentContext, TrackEntryBuilder> {
        const builders = new Map<TrackBuilderEntry | ParentContext, TrackEntryBuilder>(entries.map(entry => [entry, this.playOf(entry)]));
        for (let depth = Math.max(...entries.map(entry => entry.repeatingAncestors.length)) - 1; depth >= 0; depth--) {
            const entriesInSequences = entries.filter(entry => depth < entry.repeatingAncestors.length);
            for (const [sequence, sequenceEntries] of groupBy(entriesInSequences, entry => entry.repeatingAncestors[depth]!))
                builders.set(sequence, this.mergedOf(sequence, sequenceEntries, builders, depth));
        }
        return builders;
    }

    /**
     * The builder of a repeating sequence's iteration, which repeats as the sequence does, with its children's builders, in stacking order, merged into it:
     * each entry `depth` repeating sequences in, and each repeating sequence `depth + 1` in, where its first entry is.
     * A child that repeats forever plays once in it.
     */
    private mergedOf(sequence: ParentContext, entries: readonly TrackBuilderEntry[], builders: ReadonlyMap<TrackBuilderEntry | ParentContext, TrackEntryBuilder>, depth: number): TrackEntryBuilder {
        const children = [...new Set(entries.map(entry => entry.repeatingAncestors[depth + 1] ?? entry))].map(child => builders.get(child)!);
        const iteration = this.mergedIterationOf(children.map(child => child.repeatsForever ? child.playedOnce() : child));
        return TrackEntryBuilder.merged(this.nameOf(pathsOf(entries)), sequence, iteration);
    }

    /**
     * The children's plays laid out in one iteration, in stacking order, each over the ones before it.
     * A child that starts within the ones before it takes a missing start from them there.
     * One that starts where they end, or later, follows them, their end value held until then: its missing start takes their end value,
     * or, when theirs is missing too, both are the current value.
     * A missing end takes the value of the ones before it there when it ends within them; otherwise, the start of the next child that starts after it.
     */
    private mergedIterationOf(children: readonly TrackEntryBuilder[]): TrackRun<PendingValue> {
        const [first, ...rest] = children.map(child => child.laidOut);
        let iteration = first!;
        /** The children whose missing end waits for a start, in the order they end. */
        const pending = isOpen(iteration.endValue) ? [iteration] : [];
        for (const top of rest) {
            const follows = top.start >= iteration.end;
            if (follows && isOpen(top.startValue) && isOpen(iteration.endValue)) {
                assign(top.startValue, currentValueToken);
                assign(iteration.endValue, currentValueToken);
            } else
                assign(top.startValue, iteration.valueAt(top.start));
            for (const ended of shiftWhile(pending, child => child.end <= top.start)) assign(ended.endValue, top.startValue);

            if (top.end < iteration.end) assign(top.endValue, iteration.valueAt(top.end));
            else if (isOpen(top.endValue)) pending.push(top);
            iteration = follows ? TrackRun.joined([iteration, top]) : iteration.overlaid(top);
        }
        return iteration;
    }

    /** The name of a track entry that plays the animation leaves at the paths. */
    private nameOf(paths: readonly EntryPath[]): string | undefined {
        return paths.length === 1 ? this.naming.trackEntryNameOf(paths[0]) : this.naming.mergedTrackEntryNameOf(paths);
    }
}

function byStart(first: { start: Seconds }, second: { start: Seconds }): number {
    return first.start - second.start;
}

/** Whether the entry or the repeating sequence repeats forever in repeating sequences that don't, so it goes on under them, as a copy, once they end. */
function isContinuedByCopy(member: TrackBuilderEntry | ParentContext, entries: readonly TrackBuilderEntry[]): boolean {
    const repeatingAncestors = repeatingAncestorsOf(member, entries);
    return repeatingAncestors.length > 0 && repeatsForever(member) && !repeatingAncestors.some(repeatsForever);
}

/** The repeating sequences around the entry, or around the repeating sequence the entries are in, the outermost first. */
function repeatingAncestorsOf(member: TrackBuilderEntry | ParentContext, entries: readonly TrackBuilderEntry[]): readonly ParentContext[] {
    if (isTrackBuilderEntry(member)) return member.repeatingAncestors;
    const {repeatingAncestors} = entries.find(entry => entry.repeatingAncestors.includes(member))!;
    return repeatingAncestors.slice(0, repeatingAncestors.indexOf(member));
}

function isRepeating({repeatOptions: {repeat = 0}}: ParentContext): boolean {
    return repeat > 0;
}

function isTrackBuilderEntry(value: TrackBuilderEntry | ParentContext): value is TrackBuilderEntry {
    return 'stops' in value;
}

function pathsOf(entries: readonly TrackBuilderEntry[]): EntryPath[] {
    return entries.flatMap(({path}) => path ?? []);
}
