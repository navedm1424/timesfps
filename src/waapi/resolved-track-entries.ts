import type {Easing} from "../easing.ts";
import {linear} from "../easing-specifier.ts";
import type {Oscillation} from "../playback-options.ts";
import {repeatsForever, type TrackEntry, type TrackGroup, type TrackItem} from "../tracks/track-entries.ts";
import type {Progress, Seconds} from "../types.ts";
import {clamp, invLerp} from "../utils/math.ts";
import type {MissingValuesResolvedEntry} from "./missing-values.ts";
import type {NativeEffectScale} from "./native-effect-scale.ts";

/** A track item's run, name and holds, with its values as a scale in place of its stops. */
type ResolvedTrackItemFields = Omit<TrackItem, 'type' | 'stops'> & { scale: NativeEffectScale };

/** A track group's run, name and holds. */
type ResolvedTrackGroupFields = Omit<TrackGroup, 'type' | 'entries'>;

/**
 * A track item with its missing values resolved: its run through its scale, by its easing.
 * A play is one that plays once, without holds: one iteration of an item, or a part of one.
 */
export class ResolvedTrackItem implements MissingValuesResolvedEntry<string> {
    declare readonly name: string | undefined;
    declare readonly start: Seconds;
    declare readonly end: Seconds;
    declare readonly iterationDuration: Seconds;
    declare readonly repeatCount: number;
    declare readonly repeatDelay: Seconds;
    declare readonly oscillate?: Oscillation;
    declare readonly easing: Easing;
    declare readonly scale: NativeEffectScale;
    declare readonly holdsBefore: boolean;
    declare readonly holdsAfter: boolean;

    private constructor(fields: ResolvedTrackItemFields) {
        Object.assign(this, fields);
    }

    /** The item, with its values as `scale`. */
    static of({type: _, stops: __, ...fields}: TrackItem, scale: NativeEffectScale): ResolvedTrackItem {
        return new ResolvedTrackItem({...fields, scale});
    }

    /** Whether it ends: it doesn't when it repeats forever. */
    get ends(): boolean {
        return !repeatsForever(this);
    }

    /** The value its first iteration starts on. */
    get startValue(): string {
        const {scale, easing} = this.iteration(0);
        return scale.valueAt(easing.startProgress);
    }

    /** The value its last iteration ends on; it must end. */
    get endValue(): string {
        if (!this.ends)
            throw new Error("A resolved track item that repeats forever never ends, so it has no end value. Check `ends` first.");
        const {scale, easing} = this.iteration(this.repeatCount);
        return scale.valueAt(easing.endProgress);
    }

    valueAt(time: Seconds): string | undefined {
        if ((time < this.start && !this.holdsBefore) || (time >= this.end && !this.holdsAfter)) return undefined;
        return this.clampedValueAt(time);
    }

    /** Its value at `time` as though it held before and after: its iteration's then, held through the repeat delay after it. */
    clampedValueAt(time: Seconds): string {
        const play = this.iteration(iterationIndexAt(this, time));
        return play.scale.valueAt(play.progressAt(time));
    }

    /** Its iterations from `first` to `last` as plays, one after another, each one's end value held until the next starts. */
    plays(first: number, last: number): ResolvedTrackItem[] {
        return joined(range(first, last).map(index => [this.iteration(index)]));
    }

    /** The same play, from `start`. */
    moveTo(start: Seconds): ResolvedTrackItem {
        this.requirePlay("move");
        return this.with({start, end: start + this.iterationDuration});
    }

    /** What of the play runs from `start` to `end`, its easing's window narrowed to it; undefined when none of it does. A jump stays when it's from `start` up to, but not at, `end`. */
    trim(start: Seconds, end: Seconds): ResolvedTrackItem | undefined {
        this.requirePlay("trim");
        if (this.iterationDuration === 0) return start <= this.start && this.start < end ? this : undefined;

        const trimmedStart = Math.max(this.start, start);
        const trimmedEnd = Math.min(this.end, end);
        if (trimmedEnd <= trimmedStart) return undefined;
        if (trimmedStart === this.start && trimmedEnd === this.end) return this;

        const offsetOf = (time: Seconds) => invLerp(this.start, this.end, time);
        const easing = this.easing.segment(offsetOf(trimmedStart), offsetOf(trimmedEnd));
        return this.with({start: trimmedStart, end: trimmedEnd, iterationDuration: trimmedEnd - trimmedStart, easing});
    }

    /**
     * The play with what `oscillate` flips flipped, in the same time. Flipping its time runs its easing backwards;
     * flipping its values runs it from its end values to its start ones, through the mirror image of its easing's window, forwards.
     */
    flip(oscillate: Oscillation): ResolvedTrackItem {
        this.requirePlay("flip");
        if (oscillate === 'time') return this.with({easing: this.easing.reverse()});
        return this.with({easing: mirroredWindowOf(this.easing), scale: this.scale.flip()});
    }

    /** The play's end value held from where it ends until `until`; undefined when there's no time to hold it. */
    holdEnd(until: Seconds): ResolvedTrackItem | undefined {
        this.requirePlay("hold its end");
        if (until <= this.end) return undefined;
        return this.with({start: this.end, end: until, iterationDuration: until - this.end, easing: linear, scale: this.scale.heldAt(this.easing.endProgress)});
    }

    /** Its iteration at `index`, as a play: flipped, every other one of an oscillation. */
    private iteration(index: number): ResolvedTrackItem {
        const start = iterationStartOf(this, index);
        const play = this.with({start, end: start + this.iterationDuration, repeatCount: 0, repeatDelay: 0, oscillate: undefined, holdsBefore: false, holdsAfter: false});
        const flip = flipOf(this, index);
        return flip ? play.flip(flip) : play;
    }

    /** The play's easing's progress at `time`: its start progress before it, and its end progress after it, or where it starts and ends at once. */
    private progressAt(time: Seconds): Progress {
        const {start, iterationDuration, easing} = this;
        const elapsed = time - start;
        if (elapsed >= iterationDuration) return easing.endProgress;
        if (elapsed <= 0) return easing.startProgress;
        return easing.progressAt(elapsed / iterationDuration);
    }

    private with(changes: Partial<ResolvedTrackItemFields>): ResolvedTrackItem {
        const {name, start, end, iterationDuration, repeatCount, repeatDelay, oscillate, easing, scale, holdsBefore, holdsAfter} = this;
        return new ResolvedTrackItem({name, start, end, iterationDuration, repeatCount, repeatDelay, oscillate, easing, scale, holdsBefore, holdsAfter, ...changes});
    }

    /** Throws unless it's a play, since only a play can `what`. */
    private requirePlay(what: string): void {
        if (this.repeatCount !== 0 || this.holdsBefore || this.holdsAfter)
            throw new Error(`Only a play, which plays once without holds, can ${what}, but this resolved track item repeats or holds. Take its plays first.`);
    }
}

/**
 * A repeating sequence's part of a track, with its entries' missing values resolved: its run, and its first iteration as plays,
 * which each of its iterations plays, every other one of an oscillation flipped.
 */
export class ResolvedTrackGroup implements MissingValuesResolvedEntry<string> {
    declare readonly name: string | undefined;
    declare readonly start: Seconds;
    declare readonly end: Seconds;
    declare readonly iterationDuration: Seconds;
    declare readonly repeatCount: number;
    declare readonly repeatDelay: Seconds;
    declare readonly oscillate?: Oscillation;
    declare readonly holdsBefore: boolean;
    declare readonly holdsAfter: boolean;

    /** `firstIteration` is its plays, one after another without gaps. */
    private constructor(fields: ResolvedTrackGroupFields, private readonly firstIteration: readonly ResolvedTrackItem[]) {
        Object.assign(this, fields);
    }

    /**
     * The group, with its entries resolved: its first iteration is each entry's iterations, one after another, laid over each other in stacking order.
     * One that starts within the ones before it replaces them while it lasts; one that starts where they end, or later, follows them, their end value held until then.
     * Throws without entries, or when one of them holds before or repeats forever.
     */
    static of({type: _, entries: __, ...fields}: TrackGroup, entries: readonly (ResolvedTrackItem | ResolvedTrackGroup)[]): ResolvedTrackGroup {
        if (!entries.length)
            throw new Error("A repeating sequence's iteration lays out the entries in it, but it was given none. Give it at least one.");
        if (entries.some(entry => entry.holdsBefore))
            throw new Error("WAAPI doesn't hold an entry of a repeating sequence before it starts, but one of them holds before. Hold none of a repeating sequence's entries before.");
        if (!entries.every(entry => entry.ends))
            throw new Error("WAAPI lays out every iteration of an entry of a repeating sequence, but one of them repeats forever. Give the sequence that one without its repeats.");

        const [first, ...rest] = entries.map(entry => entry.plays(0, entry.repeatCount));
        return new ResolvedTrackGroup(fields, rest.reduce(overlay, first!));
    }

    /** Whether it ends: it doesn't when it repeats forever. */
    get ends(): boolean {
        return !repeatsForever(this);
    }

    valueAt(time: Seconds): string | undefined {
        if ((time < this.firstIteration[0]!.start && !this.holdsBefore) || (time >= this.end && !this.holdsAfter)) return undefined;
        return this.clampedValueAt(time);
    }

    /** Its value at `time` as though it held before and after: its iteration's then, the one before's end value held until what plays in it starts. */
    clampedValueAt(time: Seconds): string {
        const index = iterationIndexAt(this, time);
        const plays = this.iteration(index);
        if (index > 0 && time < plays[0]!.start) return this.iteration(index - 1).at(-1)!.clampedValueAt(time);
        const play = plays.findLast(play => play.start <= time) ?? plays[0]!;
        return play.clampedValueAt(time);
    }

    /** Its iterations from `first` to `last` as plays, one after another, each one's end value held until the next starts. */
    plays(first: number, last: number): ResolvedTrackItem[] {
        return joined(range(first, last).map(index => this.iteration(index)));
    }

    /** Its iteration at `index`, as plays: back to front, each one flipped, every other one of an oscillation. */
    private iteration(index: number): ResolvedTrackItem[] {
        const shift = iterationStartOf(this, index) - this.start;
        const flip = flipOf(this, index);
        if (!flip) return this.firstIteration.map(play => play.moveTo(play.start + shift));

        // A flipped iteration plays what the first plays from `start` to `end` from `mirror − end` to `mirror − start`.
        const mirror = 2 * this.start + this.iterationDuration + shift;
        return this.firstIteration.map(play => play.flip(flip).moveTo(mirror - play.end)).reverse();
    }
}

/** When the entry's iteration at `index` starts. */
function iterationStartOf({start, iterationDuration, repeatDelay}: TrackEntry, index: number): Seconds {
    return start + index * (iterationDuration + repeatDelay);
}

/** What the entry's iteration at `index` flips: every other one of an oscillation does. */
function flipOf({oscillate}: TrackEntry, index: number): Oscillation | undefined {
    return index % 2 === 1 ? oscillate : undefined;
}

/** The index of the entry's iteration at `time`, or the one before it in a repeat delay, the first before it starts, or the last after it ends. */
function iterationIndexAt({start, iterationDuration, repeatDelay, repeatCount}: TrackEntry, time: Seconds): number {
    return repeatCount === 0 ? 0 : clamp(Math.floor((time - start) / (iterationDuration + repeatDelay)), 0, repeatCount);
}

/** The indices from `first` to `last`. */
function range(first: number, last: number): number[] {
    return Array.from({length: last - first + 1}, (_, index) => first + index);
}

/** Groups of plays, one after another, each group's last end value held until the next group's first play starts. */
function joined(groups: readonly (readonly ResolvedTrackItem[])[]): ResolvedTrackItem[] {
    return groups.flatMap((plays, index) => {
        const hold = groups[index - 1]?.at(-1)!.holdEnd(plays[0]!.start);
        return hold ? [hold, ...plays] : [...plays];
    });
}

/**
 * The plays with `top`'s in place of their own for as long as `top` lasts,
 * or, when `top` starts where they end or later, followed by `top`'s, their end value held until then.
 */
function overlay(below: readonly ResolvedTrackItem[], top: readonly ResolvedTrackItem[]): ResolvedTrackItem[] {
    const start = below[0]!.start;
    const end = below.at(-1)!.end;
    const topStart = top[0]!.start;
    if (topStart >= end) return joined([below, top]);
    return [...trimmed(below, start, topStart), ...top, ...trimmed(below, top.at(-1)!.end, end)];
}

/** The plays, each trimmed to `start` to `end`. */
function trimmed(plays: readonly ResolvedTrackItem[], start: Seconds, end: Seconds): ResolvedTrackItem[] {
    return plays.flatMap(play => play.trim(start, end) ?? []);
}

/** The easing over the mirror image of its window, from 1 minus its end to 1 minus its start. */
function mirroredWindowOf(easing: Easing): Easing {
    const {windowStart, windowEnd} = easing;
    return easing.segment(invLerp(windowStart, windowEnd, 1 - windowEnd), invLerp(windowStart, windowEnd, 1 - windowStart));
}
