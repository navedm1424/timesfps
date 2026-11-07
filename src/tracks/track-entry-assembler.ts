import type {Easing} from "../easing.ts";
import type {EntryPath, Naming} from "../naming.ts";
import type {TweenStops} from "../tween-stops.ts";
import type {Seconds} from "../types.ts";
import {groupBy} from "../utils/collections.ts";
import {resolveMissingValues} from "./missing-values.ts";
import {TrackRunBuilder} from "./track-run-builder.ts";
import {repeats, repeatsForever, type TrackRunTiming} from "./track-runs.ts";
import {laidOver} from "./track-layering.ts";

/** What an animation leaf plays on one property of one target, with its timing. */
export interface TrackEntry extends TrackRunTiming {
    path: EntryPath | undefined;
    easing: Easing;
    stops: TweenStops;
    /** The timings of the sequences around it, the outermost first. One sequence's entries share one, which stands for the sequence. */
    ancestors: readonly TrackRunTiming[];
}

/** An entry with no repeating sequence around it where it's grouped. */
interface EntryUnit {
    type: 'entry';
    entry: TrackEntry;
}

/** A repeating sequence, with its entries. */
interface SequenceUnit {
    type: 'sequence';
    sequence: TrackRunTiming;
    entries: readonly TrackEntry[];
}

/** What one builder lays out and repeats as one. */
type RepeatUnit = EntryUnit | SequenceUnit;

/**
 * Turns a track's entries into the builders of its track runs, in stacking order: by start, then in the order they're given.
 * Each entry no sequence around repeats gets a builder of its own, with its own repeats.
 * The entries in each outermost repeating sequence merge into one builder that repeats as the sequence does, right over the continuations of what in it repeats forever.
 */
export class TrackEntryAssembler {
    constructor(private readonly naming: Naming) {}

    assemble(entries: readonly TrackEntry[]): TrackRunBuilder[] {
        return unitsIn(entries.toSorted(byStart)).flatMap(unit => [...this.continuationsUnder(unit), this.builderOf(unit)]);
    }

    /**
     * The builders that carry on under a repeating sequence's builder once it ends, sorted by start: one for the outermost of each entry's chain,
     * its repeating sequences inside this one and itself, that repeats forever. Nothing around it repeats forever, so it carries on.
     * An entry has none, and so does a sequence that repeats forever itself, since it never ends.
     */
    private continuationsUnder(unit: RepeatUnit): TrackRunBuilder[] {
        if (unit.type === 'entry' || repeatsForever(unit.sequence)) return [];
        return this.repeatingForeverIn(unit).toSorted(byStart);
    }

    /** The builders of the outermost units in the sequence, at any depth, that repeat forever. */
    private repeatingForeverIn({sequence, entries}: SequenceUnit): TrackRunBuilder[] {
        return unitsIn(entries, sequence).flatMap(unit => repeatsForever(timingOf(unit)) ? [this.builderOf(unit)]
            : unit.type === 'sequence' ? this.repeatingForeverIn(unit)
            : []);
    }

    /** The builder of an entry's iteration, or of a repeating sequence's merged iteration, that repeats as `timing` does: the unit's own by default. */
    private builderOf(unit: RepeatUnit, timing: TrackRunTiming = timingOf(unit)): TrackRunBuilder {
        if (unit.type === 'sequence')
            return merge(this.nameOf(pathsOf(unit.entries)), timing, this.unitBuildersOf(unit));
        const {path, easing, stops} = unit.entry;
        return TrackRunBuilder.fromStops(this.naming.trackRunNameOf(path), timing, easing, stops);
    }

    /**
     * The builders of the units directly in the repeating sequence, in stacking order: each entry's iteration, and the repeats of each repeating sequence in it,
     * its merged iteration built first. An entry or a repeating sequence that repeats forever plays once.
     */
    private unitBuildersOf({sequence, entries}: SequenceUnit): TrackRunBuilder[] {
        return unitsIn(entries, sequence).map(unit => this.builderOf(unit, withoutRepeatingForever(timingOf(unit))));
    }

    /** The name of a track run that plays the animation leaves at the paths. */
    private nameOf(paths: readonly EntryPath[]): string | undefined {
        return paths.length === 1 ? this.naming.trackRunNameOf(paths[0]) : this.naming.mergedTrackRunNameOf(paths);
    }
}

/**
 * The entries grouped by the repeating sequence right inside `sequence`, or by the outermost one without it, or by themselves without one,
 * each group where its first entry is.
 */
function unitsIn(entries: readonly TrackEntry[], sequence?: TrackRunTiming): RepeatUnit[] {
    const unitSequenceOf = ({ancestors}: TrackEntry): TrackRunTiming | undefined =>
        (sequence ? ancestors.slice(ancestors.indexOf(sequence) + 1) : ancestors).find(repeats);
    return [...groupBy(entries, entry => unitSequenceOf(entry) ?? entry).values()].map((group): RepeatUnit => {
        const [first] = group;
        const unitSequence = unitSequenceOf(first!);
        return unitSequence ? {type: 'sequence', sequence: unitSequence, entries: group} : {type: 'entry', entry: first!};
    });
}

/**
 * The builder of a repeating sequence's iteration that repeats as `timing` does: the units that show, laid over each other in stacking order,
 * each over the ones before it, their missing values taken as they layer, merged into it (`TrackRunBuilder.merged`).
 * A missing start that nothing ends by, or a missing end that nothing starts after, stays missing. Throws without units.
 */
function merge(name: string | undefined, timing: TrackRunTiming, units: readonly TrackRunBuilder[]): TrackRunBuilder {
    const showing = units.reduce<TrackRunBuilder[]>(laidOver, []);
    resolveMissingValues(showing);
    return TrackRunBuilder.merged(name, timing, showing);
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

function pathsOf(entries: readonly TrackEntry[]): EntryPath[] {
    return entries.flatMap(({path}) => path ?? []);
}
