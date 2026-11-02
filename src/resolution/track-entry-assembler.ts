import type {Easing} from "../easing.ts";
import type {EntryPath, Naming} from "../naming.ts";
import type {TweenStops} from "../tween-stops.ts";
import type {Seconds} from "../types.ts";
import {groupBy, shiftWhile} from "../utils/collections.ts";
import {KeyedRamp, TrackStops} from "./keyed-ramps.ts";
import {type PendingValue, type PlayTiming, repeatsForever, TrackEntryBuilder} from "./track-entry-builder.ts";
import {currentValueToken} from "./track-values.ts";

/** An animation leaf's play of one property on one target. */
export interface RawTrackEntry extends PlayTiming {
    path: EntryPath | undefined;
    easing: Easing;
    stops: TweenStops;
    /** The timings of the sequences around it, the outermost first. One sequence's entries share one, which stands for the sequence. */
    ancestors: readonly PlayTiming[];
}

/** An entry with no repeating sequence around it where it's grouped. */
interface EntryUnit {
    type: 'entry';
    entry: RawTrackEntry;
}

/** A repeating sequence, with its entries. */
interface SequenceUnit {
    type: 'sequence';
    sequence: PlayTiming;
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

    /** The builder of an entry's play, or of a repeating sequence's keyed ramp, that repeats as `timing` does: the unit's own by default. */
    private builderOf(unit: RepeatUnit, timing: PlayTiming = timingOf(unit)): TrackEntryBuilder {
        if (unit.type === 'sequence')
            return TrackEntryBuilder.merged(this.nameOf(pathsOf(unit.entries)), timing, this.keyedRampOf(unit));
        const {path, easing, stops} = unit.entry;
        return TrackEntryBuilder.play(this.naming.trackEntryNameOf(path), timing, easing, new TrackStops(stops.stops));
    }

    /**
     * The repeating sequence's keyed ramp: the plays of the entries directly in it, and the repeats of each repeating sequence in it, its keyed ramp built first,
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
function unitsIn(entries: readonly RawTrackEntry[], sequence?: PlayTiming): RepeatUnit[] {
    const unitSequenceOf = ({ancestors}: RawTrackEntry): PlayTiming | undefined =>
        (sequence ? ancestors.slice(ancestors.indexOf(sequence) + 1) : ancestors).find(isRepeating);
    return [...groupBy(entries, entry => unitSequenceOf(entry) ?? entry).values()].map((group): RepeatUnit => {
        const [first] = group;
        const unitSequence = unitSequenceOf(first!);
        return unitSequence ? {type: 'sequence', sequence: unitSequence, entries: group} : {type: 'entry', entry: first!};
    });
}

/**
 * The units' plays merged into one ramp, in stacking order, each over the ones before it.
 * A unit that starts within the ones before it takes a missing start from them there.
 * One that starts where they end, or later, follows them, their end value held until then: its missing start takes their end value,
 * or, when theirs is missing too, both are the current value.
 * A missing end takes the value of the ones before it there when it ends within them; otherwise, the start of the next unit that starts after it.
 */
function merge(units: readonly TrackEntryBuilder[]): KeyedRamp<PendingValue> {
    const [first, ...rest] = units;
    let merged = first!.laidOut;
    let endingUnit = first!;
    /** The units whose missing end waits for a start, in the order they end. */
    const pending = endingUnit.hasMissingEnd ? [endingUnit] : [];
    for (const top of rest) {
        const follows = top.start >= merged.end;
        if (follows && top.hasMissingStart && endingUnit.hasMissingEnd) {
            top.assignStart(currentValueToken);
            endingUnit.assignEnd(currentValueToken);
        } else
            top.assignStart(merged.valueAt(top.start));
        for (const ended of shiftWhile(pending, unit => unit.end <= top.start))
            ended.assignEnd(top.startValue);

        if (top.end < merged.end)
            top.assignEnd(merged.valueAt(top.end));
        else {
            if (top.hasMissingEnd)
                pending.push(top);
            endingUnit = top;
        }
        merged = follows ? KeyedRamp.joined([merged, top.laidOut]) : merged.overlaid(top.laidOut);
    }
    return merged;
}

function byStart(first: { start: Seconds }, second: { start: Seconds }): number {
    return first.start - second.start;
}

function timingOf(unit: RepeatUnit): PlayTiming {
    return unit.type === 'entry' ? unit.entry : unit.sequence;
}

/** The timing without its repeats when it repeats forever, so it plays once. */
function withoutRepeatingForever(timing: PlayTiming): PlayTiming {
    return repeatsForever(timing) ? {...timing, repeatOptions: {}} : timing;
}

function isRepeating({repeatOptions: {repeat = 0}}: PlayTiming): boolean {
    return repeat > 0;
}

function pathsOf(entries: readonly RawTrackEntry[]): EntryPath[] {
    return entries.flatMap(({path}) => path ?? []);
}
