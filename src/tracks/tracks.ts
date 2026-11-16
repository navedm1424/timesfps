import {type ByElementAndProperty, mapByElementAndProperty} from "../dom/mapping.ts";
import type {Easing} from "../easing.ts";
import type {EntryPath, Naming} from "../naming.ts";
import type {TweenStops} from "../tween-stops.ts";
import type {Seconds} from "../types.ts";
import {getOrInsertComputed} from "../utils/collections.ts";
import type {AnimationPlan, PlanNode, SequencePlan} from "../plan.ts";
import {TrackGroupBuilder, TrackItemBuilder, type TrackEntryBuilder} from "./track-entry-builder.ts";
import {layer, resolveHolds} from "./track-layering.ts";
import {repeats, repeatsForever, type TrackEntry, type TrackGroup, type TrackItem} from "./track-entries.ts";

/** Its entries in the order they show over each other in: by when they start, then in the order they're declared; a group's continuations of what in it repeats forever come right under it. */
export type Track = readonly (TrackItem | TrackGroup)[];

/** Each target's tracks by property: what every animation leaf plays on it, laid out in time. */
export type Tracks = ByElementAndProperty<Track>;

/** Lays its plan out in tracks, naming their runs by `naming`. */
export class TracksResolver {
    private readonly buildersByTarget = new Map<Element, { [property: string]: TrackBuilder }>();
    /** The timings of the sequences being added, the outermost first: every track builder has a group of each one started. */
    private readonly startedGroups: TrackEntry[] = [];

    constructor(private readonly plan: PlanNode, private readonly naming: Naming) {}

    /** Adds every animation leaf of the plan to its targets' track builders, then builds them. */
    resolve(): Tracks {
        this.addNode(this.plan);
        return mapByElementAndProperty(this.buildersByTarget, builder => builder.build());
    }

    /** Adds an animation or a sequence. */
    private addNode(node: PlanNode, path?: EntryPath): void {
        if (node.type === 'sequence')
            this.addSequence(node, path);
        else
            this.addAnimation(node, path);
    }

    /** Adds its entries in their order, in a group of every track builder that runs as it does. */
    private addSequence(sequence: SequencePlan, path?: EntryPath): void {
        this.startGroup(trackEntryOf(sequence.start, sequence));
        for (const [name, entryPlan] of sequence.entries)
            this.addNode(entryPlan, this.naming.entryPathOf(path, name));
        this.endGroup();
    }

    /** Adds a run of each property on each target, from where it starts on the target. */
    private addAnimation(animation: AnimationPlan, path?: EntryPath): void {
        const {stopsByProperty, easing, targets} = animation;
        for (const {target, start} of targets) {
            const timing = trackEntryOf(start, animation);
            for (const [property, stops] of Object.entries(stopsByProperty))
                this.trackBuilderOf(target, property).add({path, ...timing, easing, stops});
        }
    }

    private startGroup(timing: TrackEntry): void {
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
interface TrackItemEntry extends TrackEntry {
    path: EntryPath | undefined;
    easing: Easing;
    stops: TweenStops;
}

/** A sequence's part of one property of one target: its timing, and the entries in it, in their order. */
interface TrackGroupEntry extends TrackEntry {
    entries: TrackEntry[];
}

/** Each repeating group's builder, with the builders under it that continue what in it repeats forever. */
type ContinuationsByBuilder = Map<TrackEntryBuilder, readonly TrackEntryBuilder[]>;

/** The run of what starts at `start` and repeats its iterations as the entry's plan says. */
function trackEntryOf(start: Seconds, {iterationDuration, repeatCount, repeatDelay, oscillate}: PlanNode): TrackEntry {
    return {start, duration: iterationDuration, repeatCount, repeatDelay, ...(oscillate && {oscillate})};
}

/**
 * The entries that animate one property of one target, in the groups of the sequences around them, built into its track once they're all added:
 * each item entry into a builder of its own, a group that doesn't repeat into its entries' builders, and a repeating group into a builder of its own
 * that repeats as it does, with its entries' builders in it, right over the continuations of what in it repeats forever.
 */
class TrackBuilder {
    /** The entries outside every group. */
    private readonly rootEntries: TrackEntry[] = [];
    /** The groups started and not yet ended, the outermost first. */
    private readonly groups: TrackGroupEntry[] = [];
    private closed = false;

    constructor(private readonly naming: Naming) {}

    /** Starts a group inside the one started last, for the sequence that runs as `parentTiming` does: the entries added until it ends are in it. */
    startGroup(parentTiming: TrackEntry): void {
        this.requireOpen("start a group");
        this.groups.push({...parentTiming, entries: []});
    }

    /** Adds an entry to the group started last. */
    add(entry: TrackItemEntry): void {
        this.requireOpen("add an entry");
        this.activeEntries.push(entry);
    }

    /** Ends the group started last, which becomes an entry of the one around it. */
    endGroup(): void {
        this.requireOpen("end a group");
        const group = this.groups.pop();
        if (!group)
            throw new Error("A track builder ends the group started last, but none is started. Start a group before ending it.");
        this.activeEntries.push(group);
    }

    /**
     * Ends every group still started, then lays its entries' builders over each other in stacking order, each repeating group's continuations right under it,
     * and builds the ones that show, with their holds, as its track.
     */
    build(): Track {
        this.requireOpen("build it again");
        while (this.groups.length)
            this.endGroup();
        this.closed = true;

        const continuations: ContinuationsByBuilder = new Map();
        const builders = this.buildersOf(this.rootEntries, continuations).toSorted(byStart);
        const showing = layer(builders.flatMap(builder => [...continuations.get(builder) ?? [], builder]));
        resolveHolds(showing);
        return showing.map(builder => builder.build());
    }

    /** The entries of the group started last, or the ones outside every group without one. */
    private get activeEntries(): TrackEntry[] {
        return this.groups.at(-1)?.entries ?? this.rootEntries;
    }

    /**
     * The builders of the entries, in their order: an item entry's own, a group's that doesn't repeat in its place,
     * and a repeating group's own, its continuations put in `continuations` against it.
     */
    private buildersOf(entries: readonly TrackEntry[], continuations: ContinuationsByBuilder): TrackEntryBuilder[] {
        return entries.flatMap(entry => {
            if (!isGroupEntry(entry)) {
                const {path, easing, stops} = entry as TrackItemEntry;
                return [TrackItemBuilder.of(this.naming.trackItemNameOf(path), entry, easing, stops)];
            }
            if (!repeats(entry)) return this.buildersOf(entry.entries, continuations);
            const group = this.groupBuilderOf(entry, continuations);
            return group ? [group] : [];
        });
    }

    /**
     * The builder of a repeating group, which repeats as it does: its entries' builders, sorted, each played once when it repeats forever,
     * laid over each other, and the ones that show in it, with their holds, none of them holding before.
     * Unless the group repeats forever itself, its continuations go in `continuations` against it: the outermost builders in it, at any depth,
     * that repeat forever, sorted by start. Nothing around them repeats forever, so they carry on once it ends. A group without item entries has none.
     */
    private groupBuilderOf({entries, ...timing}: TrackGroupEntry, continuations: ContinuationsByBuilder): TrackEntryBuilder | undefined {
        const builders = this.buildersOf(entries, continuations).toSorted(byStart);
        if (!builders.length) return undefined;

        const showing = layer(builders.map(builder => builder.ends ? builder : builder.withoutRepeats()));
        resolveHolds(showing, {firstHoldsBefore: false});
        const group = TrackGroupBuilder.of(this.nameOf(entries), timing, showing);
        if (!repeatsForever(timing))
            continuations.set(group, builders.flatMap(builder => builder.ends ? continuations.get(builder) ?? [] : [builder]).toSorted(byStart));
        return group;
    }

    /** The name of a repeating group with the entries: from the paths of the item entries in them, at any depth, by when they start, or, with one, that item's own name. */
    private nameOf(entries: readonly TrackEntry[]): string | undefined {
        const paths = itemEntriesIn(entries).toSorted(byStart).flatMap(({path}) => path ?? []);
        return paths.length === 1 ? this.naming.trackItemNameOf(paths[0]) : this.naming.trackGroupNameOf(paths);
    }

    /** Throws once it's built, since it can't `what` then. */
    private requireOpen(what: string): void {
        if (this.closed)
            throw new Error(`A track builder is closed once it's built, so it can't ${what}. Start and end groups and add entries before building it.`);
    }
}

function isGroupEntry(entry: TrackEntry): entry is TrackGroupEntry {
    return 'entries' in entry;
}

/** The item entries in the entries, at any depth, in their order. */
function itemEntriesIn(entries: readonly TrackEntry[]): TrackItemEntry[] {
    return entries.flatMap(entry => isGroupEntry(entry) ? itemEntriesIn(entry.entries) : [entry as TrackItemEntry]);
}

function byStart(first: { start: Seconds }, second: { start: Seconds }): number {
    return first.start - second.start;
}
