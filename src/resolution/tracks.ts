import type {Easing} from "../easing.ts";
import type {RepeatOptions} from "../playback-options.ts";
import type {EntryPath, Naming} from "../naming.ts";
import type {TweenStops} from "../tween-stops.ts";
import type {Seconds} from "../types.ts";
import {getOrInsert, groupBy, popWhile, shiftWhile} from "../utils/collections.ts";
import type {AnimationPlan, PlanNode, SequencePlan} from "./plan.ts";
import {
    assign,
    isOpen,
    type PendingValue,
    type PlayTiming,
    repeatsForever,
    TrackEntryBuilder
} from "./track-entry-builder.ts";
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
        if (repeatingAncestor)
            getOrInsert(this.entryIndexesByRepeatingAncestor, repeatingAncestor, () => []).push(this.entries.length);
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
     * - The copies under a merged one take their missing starts as it does, each at its own start.
     */
    build(): Track {
        let firstStart: Seconds | undefined;
        /** The ones that show at the latest start, each over the ones that end after it. */
        const runStack: TrackEntryBuilder[] = [];
        /** The ones whose missing end waits for a start, in the order they end. */
        const pending: TrackEntryBuilder[] = [];
        /** The ones that show, in the order they show over each other in. */
        const shown = new Set<TrackEntryBuilder>();

        function resolvePendingEndValues(run: TrackEntryBuilder) {
            for (const ended of shiftWhile(pending, pendingRun => pendingRun.end <= run.start))
                ended.assignEnd(run.valueAt(run.start));
        }

        this.forEachEntry(entry => {
            const [repeatingAncestor] = entry.repeatingAncestors;
            const group = repeatingAncestor ? this.takeEntriesAt(this.entryIndexesByRepeatingAncestor.get(repeatingAncestor)!).toSorted(byStart) : [];
            const builder = repeatingAncestor ? this.repeatedIterationOf(repeatingAncestor, group) : this.playOf(entry);

            /** The outermost of each member's own repeating sequences, and itself, that repeats forever, unless it's the group's outermost member. */
            const continuedMembers = new Set(group.flatMap(member => [...member.repeatingAncestors, member].find(repeatsForever) ?? []));
            if (repeatingAncestor)
                continuedMembers.delete(repeatingAncestor);

            const copies = [...continuedMembers].map(member => isTrackBuilderEntry(member)
                ? this.playOf(member)
                : this.repeatedIterationOf(member, group.filter(groupEntry => groupEntry.repeatingAncestors.includes(member)))
            ).toSorted(byStart);

            firstStart ??= builder.start;

            const previous = popWhile(runStack, run => run.end <= builder.start).at(-1);
            const under = runStack.at(-1);
            if (under)
                builder.assignStart(under.valueAt(builder.start));
            else if (previous?.hasOpenEnd && builder.hasOpenStart) {
                builder.assignStart(currentValueToken);
                previous.assignEnd(currentValueToken);
            } else
                builder.assignStart(previous?.endValue ?? currentValueToken);

            resolvePendingEndValues(builder);

            const covered = popWhile(runStack, run => run.end <= builder.end);
            for (const run of covered) {
                if (run.start === builder.start)
                    shown.delete(run);
            }

            let copyBefore: TrackEntryBuilder | undefined;
            for (const copy of copies) {
                const previousToCopy = shiftWhile(covered, run => run.end <= copy.start).at(-1) ?? previous;
                const underCopy = copyBefore ?? covered.at(0) ?? runStack.at(-1);
                if (underCopy)
                    copy.assignStart(underCopy.valueAt(copy.start));
                else if (previousToCopy?.hasOpenEnd && copy.hasOpenStart) {
                    copy.assignStart(currentValueToken);
                    previousToCopy.assignEnd(currentValueToken);
                } else
                    copy.assignStart(previousToCopy?.endValue ?? currentValueToken);
                resolvePendingEndValues(copy);
                runStack.push(copy);
                copyBefore = copy;
            }
            const landing = runStack.at(-1);
            if (landing)
                builder.assignEnd(landing.valueAt(builder.end));
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
        });
        return [...shown].map(builder => builder.build());
    }

    private forEachEntry(callback: (entry: TrackBuilderEntry) => void): void {
        const {entries} = this;
        for (const index of Array.from(entries.keys()).sort((first, second) => byStart(entries[first]!, entries[second]!))) {
            const entry = entries[index];
            if (!entry) continue;
            callback(entry);
        }
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

    /** The builder of a repeating sequence's iteration, unwrapped from its entries, that repeats as `timing` does: the sequence's own by default. */
    private repeatedIterationOf(sequence: ParentContext, entries: readonly TrackBuilderEntry[], timing: PlayTiming = sequence): TrackEntryBuilder {
        return TrackEntryBuilder.merged(this.nameOf(pathsOf(entries)), timing, this.unwrap(sequence, entries));
    }

    /**
     * The repeating sequence's iteration: the plays of the entries directly in it, and the repeats of each repeating sequence in it, its iteration unwrapped first,
     * merged in stacking order. An entry or a repeating sequence that repeats forever plays once.
     */
    private unwrap(sequence: ParentContext, entries: readonly TrackBuilderEntry[]): TrackRun<PendingValue> {
        const childOf = ({repeatingAncestors}: TrackBuilderEntry) => repeatingAncestors[repeatingAncestors.indexOf(sequence) + 1];
        const runs = [...groupBy(entries, entry => childOf(entry) ?? entry)].map(([child, childEntries]) => isTrackBuilderEntry(child)
            ? this.playOf(withoutEndlessRepeats(child)).laidOut
            : this.repeatedIterationOf(child, childEntries, withoutEndlessRepeats(child)).laidOut
        );
        return this.merge(runs);
    }

    /**
     * The runs merged into one, in stacking order, each over the ones before it.
     * A run that starts within the ones before it takes a missing start from them there.
     * One that starts where they end, or later, follows them, their end value held until then: its missing start takes their end value,
     * or, when theirs is missing too, both are the current value.
     * A missing end takes the value of the ones before it there when it ends within them; otherwise, the start of the next run that starts after it.
     */
    private merge(runs: readonly TrackRun<PendingValue>[]): TrackRun<PendingValue> {
        const [first, ...rest] = runs;
        let merged = first!;
        /** The runs whose missing end waits for a start, in the order they end. */
        const pending = isOpen(merged.endValue) ? [merged] : [];
        for (const top of rest) {
            const follows = top.start >= merged.end;
            if (follows && isOpen(top.startValue) && isOpen(merged.endValue)) {
                assign(top.startValue, currentValueToken);
                assign(merged.endValue, currentValueToken);
            } else
                assign(top.startValue, merged.valueAt(top.start));
            for (const ended of shiftWhile(pending, run => run.end <= top.start)) assign(ended.endValue, top.startValue);

            if (top.end < merged.end) assign(top.endValue, merged.valueAt(top.end));
            else if (isOpen(top.endValue)) pending.push(top);
            merged = follows ? TrackRun.joined([merged, top]) : merged.overlaid(top);
        }
        return merged;
    }

    /** The name of a track entry that plays the animation leaves at the paths. */
    private nameOf(paths: readonly EntryPath[]): string | undefined {
        return paths.length === 1 ? this.naming.trackEntryNameOf(paths[0]) : this.naming.mergedTrackEntryNameOf(paths);
    }
}

function byStart(first: { start: Seconds }, second: { start: Seconds }): number {
    return first.start - second.start;
}

/** The timing without its repeats when it repeats forever, so it plays once. */
function withoutEndlessRepeats<Timing extends PlayTiming>(timing: Timing): Timing {
    return repeatsForever(timing) ? {...timing, repeatOptions: {}} : timing;
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
