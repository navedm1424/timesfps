import type {Easing} from "../easing.ts";
import type {RepeatOptions} from "../playback-options.ts";
import type {EntryPath, Naming} from "../naming.ts";
import type {TweenStops} from "../tween-stops.ts";
import type {Seconds} from "../types.ts";
import {groupBy} from "../utils/collections.ts";
import type {AnimationPlan, PlanNode, SequencePlan} from "./plan.ts";
import {TrackEntryBuilder} from "./track-entry-builder.ts";
import {type TrackRun, TrackStops} from "./track-runs.ts";
import type {TrackValue} from "./track-values.ts";

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
        const buildersByProperty = this.buildersByTarget.get(target) ?? {};
        this.buildersByTarget.set(target, buildersByProperty);
        return buildersByProperty[property] ??= new TrackBuilder(this.naming);
    }
}

/** The entries that animate one property of one target, built into its track once they're all added. */
class TrackBuilder {
    /** In stacking order: by when they start, ties in the order they're added. */
    private readonly entries: TrackBuilderEntry[] = [];

    constructor(private readonly naming: Naming) {}

    /** Adds the entry after every entry that starts no later than it. */
    add(entry: Omit<TrackBuilderEntry, 'repeatingAncestors'>): void {
        const laterIndex = this.entries.findIndex(other => other.start > entry.start);
        this.entries.splice(laterIndex === -1 ? this.entries.length : laterIndex, 0, {...entry, repeatingAncestors: entry.ancestors.filter(isRepeating)});
    }

    /**
     * Builds a track entry for each entry no sequence around repeats, with its own repeats,
     * and one for each outermost repeating sequence, its entries merged into it, that repeats as the sequence does, over copies of what in it repeats forever.
     * Then lays them out over each other, and leaves out the ones that never show.
     */
    build(): Track {
        const builders = this.buildersOf(this.entries);
        layOut(builders);
        return builders.flatMap(builder => builder.layers).flatMap(builder => builder.build() ?? []);
    }

    /**
     * The builders of the entries, in stacking order: one for each entry without a repeating ancestor at `depth`,
     * and one for each repeating ancestor at `depth`, where its first entry is, with its entries merged into it.
     */
    private buildersOf(entries: readonly TrackBuilderEntry[], depth: number = 0): TrackEntryBuilder[] {
        return [...groupBy(entries, entry => entry.repeatingAncestors[depth] ?? entry)].map(([key, group]) => isTrackBuilderEntry(key)
            ? TrackEntryBuilder.play(this.naming.trackEntryNameOf(key.path), key, key.easing, new TrackStops(key.stops.stops))
            : TrackEntryBuilder.merged(this.nameOf(pathsOf(group)), key, this.buildersOf(group, depth + 1))
        );
    }

    /** The name of a track entry that plays the animation leaves at the paths. */
    private nameOf(paths: readonly EntryPath[]): string | undefined {
        return paths.length === 1 ? this.naming.trackEntryNameOf(paths[0]) : this.naming.mergedTrackEntryNameOf(paths);
    }
}

/**
 * Lays the builders out over each other in stacking order, each one's copies under it, in one walk.
 * - A missing start takes the value of the one under it there. With none under it, it takes the end value of the one that ended last,
 *   and when that one's end is missing too, both are the current value. With none before it, it's the current value.
 * - A missing end takes the value of the one under it there that ends after it. With none, it waits for the next one that starts once it has ended, and takes its start.
 * - The ones under it that end with or before it never show again, and the ones that start with it never show at all.
 * - It holds after it ends when nothing under it runs on after that, and before it starts when it's among the ones that start first.
 * - The copies under a merged one have its values, and take none of their own.
 */
function layOut(builders: readonly TrackEntryBuilder[]): void {
    const firstStart = builders[0]?.start;
    /** The ones that show at the latest start, each over the ones that end after it. */
    const shown: TrackEntryBuilder[] = [];
    /** The ones whose missing end waits for a start, in the order they end. */
    const pending: TrackEntryBuilder[] = [];
    /** Takes the ones that end by `time` off `shown`, hides those that start with `over`, and gives the last one it took. */
    function takeEndedBy(time: Seconds, over: TrackEntryBuilder): TrackEntryBuilder | undefined {
        let taken: TrackEntryBuilder | undefined;
        while (shown.length > 0 && shown.at(-1)!.end <= time) {
            taken = shown.pop()!;
            if (taken.start === over.start) taken.hide();
        }
        return taken;
    }

    for (const builder of builders) {
        const previous = takeEndedBy(builder.start, builder);
        const under = shown.at(-1);
        if (under) builder.assignStartInterpolation(under);
        else if (previous?.hasOpenEnd && builder.hasOpenStart) {
            builder.assignStartCurrentValue();
            previous.assignEndCurrentValue();
        } else if (previous) builder.assignStartInterpolation(previous);
        else builder.assignStartCurrentValue();
        while (pending[0] && pending[0].end <= builder.start) pending.shift()!.assignEndInterpolation(builder);

        for (const layer of builder.layers) {
            takeEndedBy(layer.end, layer);
            const landing = shown.at(-1);
            if (landing) layer.assignEndInterpolation(landing);
            else {
                layer.holdAfter();
                if (layer.hasOpenEnd) pending.push(layer);
            }
            if (layer.start === firstStart) layer.holdBefore();
            shown.push(layer);
        }
    }
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
