import type {Easing} from "../easing.ts";
import type {EntryPath, Naming} from "../naming.ts";
import type {TweenStops} from "../tween-stops.ts";
import type {Seconds} from "../types.ts";
import {groupBy} from "../utils/collections.ts";
import {KeyedRamp} from "./keyed-ramps.ts";
import {resolveMissingValues} from "./missing-values.ts";
import {repeats, repeatsForever, type TrackRunTiming} from "./track-entries.ts";
import {type PendingValue, TrackEntryBuilder} from "./track-entry-builder.ts";
import {laidOver} from "./track-layering.ts";

/** An animation leaf's run of one property on one target. */
export interface RawTrackEntry extends TrackRunTiming {
    path: EntryPath | undefined;
    easing: Easing;
    stops: TweenStops;
    /** The timings of the sequences around it, the outermost first. One sequence's entries share one, which stands for the sequence. */
    ancestors: readonly TrackRunTiming[];
}

/** An entry with no repeating sequence around it where it's grouped. */
interface EntryUnit {
    type: 'entry';
    entry: RawTrackEntry;
}

/** A repeating sequence, with its entries. */
interface SequenceUnit {
    type: 'sequence';
    sequence: TrackRunTiming;
    entries: readonly RawTrackEntry[];
}

/** What one builder lays out and repeats as one. */
type RepeatUnit = EntryUnit | SequenceUnit;

/**
 * Turns a track's raw entries into the builders of its track entries, in stacking order: by start, then in the order they're given.
 * Each entry no sequence around repeats gets a builder of its own, with its own repeats.
 * The entries in each outermost repeating sequence merge into one builder that repeats as the sequence does, right over the continuations of what in it repeats forever.
 */
export class TrackEntryAssembler {
    constructor(private readonly naming: Naming) {}

    assemble(entries: readonly RawTrackEntry[]): TrackEntryBuilder[] {
        return unitsIn(entries.toSorted(byStart)).flatMap(unit => [...this.continuationsUnder(unit), this.builderOf(unit)]);
    }

    /**
     * The builders that carry on under a repeating sequence's builder once it ends, sorted by start: one for the outermost of each entry's chain,
     * its repeating sequences inside this one and itself, that repeats forever. Nothing around it repeats forever, so it carries on.
     * An entry has none, and so does a sequence that repeats forever itself, since it never ends.
     */
    private continuationsUnder(unit: RepeatUnit): TrackEntryBuilder[] {
        if (unit.type === 'entry' || repeatsForever(unit.sequence)) return [];
        return this.repeatingForeverIn(unit).toSorted(byStart);
    }

    /** The builders of the outermost units in the sequence, at any depth, that repeat forever. */
    private repeatingForeverIn({sequence, entries}: SequenceUnit): TrackEntryBuilder[] {
        return unitsIn(entries, sequence).flatMap(unit => repeatsForever(timingOf(unit)) ? [this.builderOf(unit)]
            : unit.type === 'sequence' ? this.repeatingForeverIn(unit)
            : []);
    }

    /** The builder of an entry's iteration, or of a repeating sequence's keyed ramp, that repeats as `timing` does: the unit's own by default. */
    private builderOf(unit: RepeatUnit, timing: TrackRunTiming = timingOf(unit)): TrackEntryBuilder {
        if (unit.type === 'sequence')
            return TrackEntryBuilder.merged(this.nameOf(pathsOf(unit.entries)), timing, this.keyedRampOf(unit));
        const {path, easing, stops} = unit.entry;
        return TrackEntryBuilder.fromStops(this.naming.trackEntryNameOf(path), timing, easing, stops);
    }

    /**
     * The repeating sequence's keyed ramp: the iterations of the entries directly in it, and the repeats of each repeating sequence in it, its keyed ramp built first,
     * merged in stacking order. An entry or a repeating sequence that repeats forever plays once.
     */
    private keyedRampOf({sequence, entries}: SequenceUnit): KeyedRamp<PendingValue> {
        return merge(unitsIn(entries, sequence).map(unit => this.builderOf(unit, withoutRepeatingForever(timingOf(unit)))));
    }

    /** The name of a track entry that plays the animation leaves at the paths. */
    private nameOf(paths: readonly EntryPath[]): string | undefined {
        return paths.length === 1 ? this.naming.trackEntryNameOf(paths[0]) : this.naming.mergedTrackEntryNameOf(paths);
    }
}

/**
 * The entries grouped by the repeating sequence right inside `sequence`, or by the outermost one without it, or by themselves without one,
 * each group where its first entry is.
 */
function unitsIn(entries: readonly RawTrackEntry[], sequence?: TrackRunTiming): RepeatUnit[] {
    const unitSequenceOf = ({ancestors}: RawTrackEntry): TrackRunTiming | undefined =>
        (sequence ? ancestors.slice(ancestors.indexOf(sequence) + 1) : ancestors).find(repeats);
    return [...groupBy(entries, entry => unitSequenceOf(entry) ?? entry).values()].map((group): RepeatUnit => {
        const [first] = group;
        const unitSequence = unitSequenceOf(first!);
        return unitSequence ? {type: 'sequence', sequence: unitSequence, entries: group} : {type: 'entry', entry: first!};
    });
}

/**
 * The iterations of the units that show merged into one ramp, in stacking order, each over the ones before it, their missing values taken as they layer.
 * One that starts within the ones before it replaces them while it lasts; one that starts where they end, or later, follows them, their end value held until then.
 * A missing start that nothing ends by, or a missing end that nothing starts after, stays missing.
 * Throws without units, since a keyed ramp has at least one span.
 */
function merge(units: readonly TrackEntryBuilder[]): KeyedRamp<PendingValue> {
    if (!units.length)
        throw new Error("A repeating sequence's keyed ramp merges the units in it, but it has none. Merge at least one unit.");
    const showing = units.reduce<TrackEntryBuilder[]>(laidOver, []);
    resolveMissingValues(showing);

    const [first, ...rest] = showing;
    return rest.reduce((merged, top) => top.start >= merged.end ? KeyedRamp.joined([merged, top.laidOut]) : merged.overlaid(top.laidOut), first!.laidOut);
}

function byStart(first: { start: Seconds }, second: { start: Seconds }): number {
    return first.start - second.start;
}

function timingOf(unit: RepeatUnit): TrackRunTiming {
    return unit.type === 'entry' ? unit.entry : unit.sequence;
}

/** The timing without its repeats when it repeats forever, so it plays once. */
function withoutRepeatingForever(timing: TrackRunTiming): TrackRunTiming {
    return repeatsForever(timing) ? {start: timing.start, duration: timing.duration, repeatCount: 0, repeatDelay: 0} : timing;
}

function pathsOf(entries: readonly RawTrackEntry[]): EntryPath[] {
    return entries.flatMap(({path}) => path ?? []);
}
