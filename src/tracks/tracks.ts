import {type ByElementAndProperty, mapByElementAndProperty} from "../dom/mapping.ts";
import type {Easing} from "../easing.ts";
import type {EntryPath, Naming} from "../naming.ts";
import type {RepeatOptions} from "../playback-options.ts";
import type {TweenStops} from "../tween-stops.ts";
import type {Seconds} from "../types.ts";
import {getOrInsertComputed} from "../utils/collections.ts";
import type {AnimationPlan, PlanNode, SequencePlan} from "../plan.ts";
import {TrackRunBuilder} from "./track-run-builder.ts";
import {layer, merge} from "./track-layering.ts";
import {type Oscillation, repeats, repeatsForever, type TrackRun, type TrackRunTiming} from "./track-runs.ts";
import type {TrackValue} from "./track-values.ts";

/** Its runs in the order they show over each other in: by when they start, then in the order they're declared; a merged run's continuations of what in it repeats forever come right under it. */
export type Track = readonly TrackRun<TrackValue>[];

/** Each target's tracks by property: what every animation leaf plays on it, laid out in time. */
export type Tracks = ByElementAndProperty<Track>;

/** Lays its plan out in tracks, naming their runs by `naming`. */
export class TracksResolver {
    private readonly buildersByTarget = new Map<Element, { [property: string]: TrackBuilder }>();
    /** The timings of the sequences being added, the outermost first: every track builder has a group of each one started. */
    private readonly startedGroups: TrackRunTiming[] = [];

    constructor(private readonly plan: PlanNode, private readonly naming: Naming) {}

    /** Adds every animation leaf of the plan to its targets' track builders, then builds them. */
    resolve(): Tracks {
        this.addNode(this.plan, 0);
        return mapByElementAndProperty(this.buildersByTarget, builder => builder.build());
    }

    /** Adds an animation or a sequence, which starts at its position after the sequence it's in starts, at `sequenceStart`. */
    private addNode(node: PlanNode, sequenceStart: Seconds, path?: EntryPath): void {
        const start = sequenceStart + node.position;
        if (node.type === 'sequence')
            this.addSequence(node, start, path);
        else
            this.addAnimation(node, start, path);
    }

    /** Adds its entries in their order, in a group of every track builder that runs as it does, `start` after the outermost definition starts. */
    private addSequence({entries, iterationDuration, repeatOptions}: SequencePlan, start: Seconds, path?: EntryPath): void {
        this.startGroup(trackRunTimingOf(start, iterationDuration, repeatOptions));
        for (const [name, entryPlan] of entries)
            this.addNode(entryPlan, start, this.naming.entryPathOf(path, name));
        this.endGroup();
    }

    /** Adds a run of each property on each target, `start` and the target's delay after the outermost definition starts. */
    private addAnimation({stopsByProperty, easing, iterationDuration, repeatOptions, targets}: AnimationPlan, start: Seconds, path?: EntryPath): void {
        for (const {target, delay} of targets) {
            const timing = trackRunTimingOf(start + delay, iterationDuration, repeatOptions);
            for (const [property, stops] of Object.entries(stopsByProperty))
                this.trackBuilderOf(target, property).add({path, ...timing, easing, stops});
        }
    }

    private startGroup(timing: TrackRunTiming): void {
        this.startedGroups.push(timing);
        for (const buildersByProperty of this.buildersByTarget.values())
            for (const property in buildersByProperty)
                buildersByProperty[property]!.startGroup(timing);
    }

    private endGroup(): void {
        this.startedGroups.pop();
        for (const buildersByProperty of this.buildersByTarget.values())
            for (const property in buildersByProperty)
                buildersByProperty[property]!.endGroup();
    }

    /** The target's track builder of the property; a new one has a group of each sequence being added started. */
    private trackBuilderOf(target: Element, property: string): TrackBuilder {
        const buildersByProperty = getOrInsertComputed(this.buildersByTarget, target, () => ({}));
        return buildersByProperty[property] ??= this.newTrackBuilder();
    }

    private newTrackBuilder(): TrackBuilder {
        const builder = new TrackBuilder(this.naming);
        for (const timing of this.startedGroups)
            builder.startGroup(timing);
        return builder;
    }
}

/** What an animation leaf plays on one property of one target, with its timing. */
interface TrackEntry extends TrackRunTiming {
    path: EntryPath | undefined;
    easing: Easing;
    stops: TweenStops;
}

/** Each builder, with the builders under it that continue what in it repeats forever. */
type ContinuationsByBuilder = Map<TrackRunBuilder, readonly TrackRunBuilder[]>;

/** The run of what starts at `start` and repeats iterations of `duration` as `repeatOptions` say; one without duration doesn't repeat. */
function trackRunTimingOf(start: Seconds, duration: Seconds, {repeat = 0, repeatDelay = 0, repeatMode = 'loop'}: RepeatOptions): TrackRunTiming {
    if (duration === 0 || repeat === 0) return {start, duration, repeatCount: 0, repeatDelay: 0};
    const oscillate: Oscillation | undefined = repeatMode === 'reverse' ? 'time' : repeatMode === 'mirror' ? 'values' : undefined;
    return {start, duration, repeatCount: repeat, repeatDelay, ...(oscillate && {oscillate})};
}

/**
 * The entries that animate one property of one target, in the groups of the sequences around them, built into its track once they're all added.
 * Each entry gets a builder of its own. Once a group ends, a repeating one's builders merge into one builder that repeats as it does,
 * right over the continuations of what in it repeats forever; another one's builders join the group around it.
 */
class TrackBuilder {
    /** The builders outside every group. */
    private readonly builders: ContinuationsByBuilder = new Map();
    /** The groups started and not yet ended, the outermost first: each one's timing, its builders, and the entries in it at any depth, in their order. */
    private readonly groups: { timing: TrackRunTiming, builders: ContinuationsByBuilder, entries: TrackEntry[] }[] = [];
    private closed = false;

    constructor(private readonly naming: Naming) {}

    /** Starts a group inside the one started last, for the sequence that runs as `parentTiming` does: the entries added until it ends are in it. */
    startGroup(parentTiming: TrackRunTiming): void {
        this.requireOpen("start a group");
        this.groups.push({timing: parentTiming, builders: new Map(), entries: []});
    }

    /** Adds an entry, with a builder of its own, to the group started last. */
    add(entry: TrackEntry): void {
        this.requireOpen("add an entry");
        const {path, easing, stops} = entry;
        this.activeBuilders.set(TrackRunBuilder.fromStops(this.naming.trackRunNameOf(path), entry, easing, stops), []);
        for (const group of this.groups)
            group.entries.push(entry);
    }

    /**
     * Ends the group started last. When it repeats, its builders merge into one, in stacking order, with the continuations under it of what in it repeats forever,
     * sorted by start, unless it repeats forever itself; otherwise its builders join the group around it in stacking order. A group without builders adds nothing.
     */
    endGroup(): void {
        this.requireOpen("end a group");
        const group = this.groups.pop();
        if (!group)
            throw new Error("A track builder ends the group started last, but none is started. Start a group before ending it.");
        if (!group.builders.size) return;

        const builders = inStackingOrder(group.builders);
        if (!repeats(group.timing)) {
            for (const [builder, continuations] of builders)
                this.activeBuilders.set(builder, continuations);
            return;
        }
        const merged = merge(this.nameOf(group.entries), group.timing, builders.map(([builder]) => builder.withoutRepeatingForever()));
        this.activeBuilders.set(merged, repeatsForever(group.timing) ? [] : continuationsIn(builders));
    }

    /** Ends every group still started, then lays its builders over each other in stacking order, each merged one's continuations right under it, as its track. */
    build(): Track {
        this.requireOpen("build it again");
        while (this.groups.length)
            this.endGroup();
        this.closed = true;
        return layer(inStackingOrder(this.builders).flatMap(([builder, continuations]) => [...continuations, builder]));
    }

    /** The builders of the group started last, or the ones outside every group without one. */
    private get activeBuilders(): ContinuationsByBuilder {
        return this.groups.at(-1)?.builders ?? this.builders;
    }

    /** The name of a merged run of the entries: from their paths, by when they start. */
    private nameOf(entries: readonly TrackEntry[]): string | undefined {
        const paths = entries.toSorted(byStart).flatMap(({path}) => path ?? []);
        return paths.length === 1 ? this.naming.trackRunNameOf(paths[0]) : this.naming.sequenceTrackRunNameOf(paths);
    }

    /** Throws once it's built, since it can't `what` then. */
    private requireOpen(what: string): void {
        if (this.closed)
            throw new Error(`A track builder is closed once it's built, so it can't ${what}. Start and end groups and add entries before building it.`);
    }
}

/** The builders by start, ties in the order they were added. */
function inStackingOrder(builders: ContinuationsByBuilder): [TrackRunBuilder, readonly TrackRunBuilder[]][] {
    return [...builders].toSorted(([first], [second]) => byStart(first, second));
}

/** The outermost of the builders, at any depth, that repeat forever, sorted by start. Nothing around them repeats forever, so they carry on once the others end. */
function continuationsIn(builders: readonly [TrackRunBuilder, readonly TrackRunBuilder[]][]): TrackRunBuilder[] {
    return builders.flatMap(([builder, continuations]) => builder.ends ? continuations : [builder]).toSorted(byStart);
}

function byStart(first: { start: Seconds }, second: { start: Seconds }): number {
    return first.start - second.start;
}
