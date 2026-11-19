import type {Oscillation} from "../playback-options.ts";
import {repeatsForever, type TrackEntry, type TrackGroup, type TrackItem, type TrackStop} from "../tracks/track-entries.ts";
import type {Seconds} from "../types.ts";
import {clamp} from "../utils/math.ts";
import {easingAndKeyframesOf, type NativeKeyframe} from "./keyframes.ts";
import type {MissingValuesResolvedEntry} from "./missing-values.ts";
import type {NativeEasing} from "./native-easing.ts";
import {Segment} from "./segment.ts";
import type {TrackValues} from "./track-values.ts";

/** One WAAPI effect on one property. */
export interface NativeEffect {
    delay: Seconds;
    duration: Seconds;
    iterations: number;
    direction: PlaybackDirection;
    fill: FillMode;
    easing: NativeEasing;
    keyframes: NativeKeyframe[];
    /** Its track entry's, which an animation on its own doesn't have. */
    name: string | undefined;
}

/** A stretch of time, and the segments that play in it, one after another without gaps, their offsets fractions of it. */
interface Stretch {
    /** After the outermost definition starts. */
    start: Seconds;
    duration: Seconds;
    segments: readonly Segment[];
}

/**
 * What WAAPI plays for one track entry, its missing values resolved: its timing, its holds, and one iteration as segments.
 * An item's iteration plays its stops through its whole easing, and a repeating group's merges its entries' iterations.
 * It builds into as many effects as WAAPI takes to repeat it.
 */
export class NativeEffectBuilder implements MissingValuesResolvedEntry<string> {
    private constructor(
        private readonly entry: TrackItem | TrackGroup,
        /** One iteration, its offsets fractions of it. */
        private readonly segments: readonly Segment[],
        /** When what plays in its first iteration starts. */
        readonly start: Seconds,
        /** When what plays in its first iteration ends. */
        private readonly firstIterationEnd: Seconds,
        /** When its last iteration ends; `Infinity` when it never ends. */
        readonly end: Seconds,
        private readonly values: TrackValues
    ) {}

    /** An item's builder, with its stops' texts: one segment, its stops through its whole easing. */
    static ofItem(item: TrackItem, stops: readonly TrackStop<string>[], values: TrackValues): NativeEffectBuilder {
        return new NativeEffectBuilder(item, [new Segment(0, 1, item.easing, stops)], item.start, item.start + item.iterationDuration, endOf(item), values);
    }

    /**
     * A repeating group's builder, with its entries' builders: its iteration is each entry's iterations, one after another, as fractions of it,
     * laid over each other in stacking order. One that starts within the ones before it replaces them while it lasts;
     * one that starts where they end, or later, follows them, their end value held until then.
     * Throws without entries, when the group's iteration has no duration, or when one of its entries holds before or repeats forever.
     */
    static ofGroup(group: TrackGroup, entries: readonly NativeEffectBuilder[], values: TrackValues): NativeEffectBuilder {
        if (!entries.length)
            throw new Error("A repeating sequence's iteration lays out the entries in it, but it was given none. Give it at least one.");
        if (!(group.iterationDuration > 0))
            throw new Error(`A repeating sequence's iteration places the entries in it as fractions of its duration, which is ${group.iterationDuration}. Give it an iteration that lasts some time; one without duration never repeats.`);
        if (entries.some(entry => entry.holdsBefore))
            throw new Error("WAAPI doesn't hold an entry of a repeating sequence before it starts, but one of them holds before. Hold none of a repeating sequence's entries before.");
        if (!entries.every(entry => entry.ends))
            throw new Error("WAAPI lays out every iteration of an entry of a repeating sequence, but one of them repeats forever. Give the sequence that one without its repeats.");

        const iteration = {start: group.start, duration: group.iterationDuration};
        const [first, ...rest] = entries.map(entry => segmentsIn(entry.stretch(0, entry.entry.repeatCount), iteration));
        const segments = rest.reduce((below, top) => overlay(below, top, values), first!);
        const start = Math.min(...entries.map(entry => entry.start));
        const entriesEnd = Math.max(...entries.map(entry => entry.end));
        return new NativeEffectBuilder(group, segments, start, entriesEnd, groupEndOf(group, start, entriesEnd), values);
    }

    get name(): string | undefined {
        return this.entry.name;
    }

    /** Whether it holds the value it starts on before it starts. */
    get holdsBefore(): boolean {
        return this.entry.holdsBefore;
    }

    /** Whether it holds the value it ends on once it's done. */
    get holdsAfter(): boolean {
        return this.entry.holdsAfter;
    }

    /** Whether it ends: it doesn't when it repeats forever. */
    get ends(): boolean {
        return !repeatsForever(this.entry);
    }

    /**
     * Its value at `time`: its iteration's then, the end value of the one before held through the repeat delay until what plays in the next one starts;
     * before it starts, the value it starts on, when it holds it; once it's done, the value it ends on, when it holds it; undefined otherwise.
     */
    valueAt(time: Seconds): string | undefined {
        if (time < this.start) return this.holdsBefore ? this.startValueOf(this.iteration(0)) : undefined;
        if (time >= this.end) return this.holdsAfter ? this.endValueOf(this.iteration(this.entry.repeatCount)) : undefined;

        const index = this.iterationIndexAt(time);
        const iteration = this.iteration(index);
        const elapsed = time - iteration.start;
        if (index > 0 && elapsed < this.playStartIn(index)) return this.endValueOf(this.iteration(index - 1));
        if (elapsed >= this.playEndIn(index)) return this.endValueOf(iteration);

        const offset = elapsed / iteration.duration;
        const segment = iteration.segments.findLast(segment => segment.startOffset <= offset) ?? iteration.segments[0]!;
        return this.values.textAt(segment.stops, segment.progressAt(offset));
    }

    /**
     * Its effects: its repeats as WAAPI iterations where WAAPI can repeat them, and laid out in keyframes where it can't.
     * The first effect holds before it when it does, and every effect holds after it when it does.
     */
    build(): NativeEffect[] {
        const {repeatCount, repeatDelay, oscillate} = this.entry;
        const playCount = repeatCount + 1;
        const effect = (
            first: number,
            last: number,
            {iterations = 1, direction = 'normal', holdsUntilNext = false}: { iterations?: number; direction?: PlaybackDirection; holdsUntilNext?: boolean } = {}
        ): NativeEffect => {
            const {start, duration, segments} = this.stretch(first, last, {holdsUntilNext});
            const fill = fillOf(first === 0 && this.holdsBefore, this.holdsAfter);
            return {delay: start, duration, iterations, direction, fill, name: this.name, ...easingAndKeyframesOf(segments, duration, this.values)};
        };

        // iteration
        if (repeatCount === 0)
            return [effect(0, 0)];

        // iteration × playCount, alternating when it oscillates in time
        if (oscillate !== 'values' && repeatDelay === 0 && this.segments[0]!.startOffset === 0 && this.segments.at(-1)!.endOffset === 1)
            return [effect(0, 0, {iterations: playCount, direction: oscillate === 'time' ? 'alternate' : 'normal'})];

        // [iteration+hold] × repeatCount, then the last iteration on its own; [iteration+hold] × ∞ when repeating forever
        if (!oscillate) {
            const repeating = effect(0, 0, {iterations: repeatCount, holdsUntilNext: true});
            return this.ends ? [repeating, effect(repeatCount, repeatCount)] : [repeating];
        }

        const repeatingPairs = (iterations: number) => effect(0, 1, {iterations, holdsUntilNext: true});

        // [iteration+hold, flipped+hold] × ∞
        if (!this.ends)
            return [repeatingPairs(Infinity)];

        // [iteration+hold, flipped+hold] × repeatCount/2, then the last iteration on its own
        if (playCount % 2 === 1)
            return [repeatingPairs(repeatCount / 2), effect(repeatCount, repeatCount)];

        // [iteration+hold, flipped] on its own
        if (playCount === 2)
            return [effect(0, 1)];

        // [iteration+hold, flipped+hold] × (repeatCount−1)/2, then [iteration+hold, flipped] on its own
        return [repeatingPairs((repeatCount - 1) / 2), effect(repeatCount - 1, repeatCount)];
    }

    /**
     * Its iterations from `first` to `last`, one after another, each one's end value held until the next starts, as a stretch from where the first one's
     * segments start to where the last one's end; with `holdsUntilNext`, the last one's end value is held too, until the iteration after it would start.
     * A stretch without duration keeps its segments' offsets in their iteration. Throws for iterations it doesn't have.
     */
    private stretch(first: number, last: number, {holdsUntilNext = false}: { holdsUntilNext?: boolean } = {}): Stretch {
        const {repeatCount} = this.entry;
        if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || first > last || last > repeatCount)
            throw new Error(`A native effect builder's iterations are 0 to its repeat count, ${repeatCount}, but iterations ${first} to ${last} were asked for. Ask for whole iterations within that range, the first one no later than the last.`);

        const iterations = Array.from({length: last - first + 1}, (_, index) => this.iteration(first + index));
        const firstIteration = iterations[0]!;
        const lastIteration = iterations.at(-1)!;
        const next = holdsUntilNext ? this.iteration(last + 1) : undefined;
        const start = timeAt(firstIteration, firstIteration.segments[0]!.startOffset);
        const end = next ? timeAt(next, next.segments[0]!.startOffset) : timeAt(lastIteration, lastIteration.segments.at(-1)!.endOffset);
        const duration = end - start;
        if (duration === 0) return {start, duration, segments: firstIteration.segments};

        const placed = iterations.map(iteration => segmentsIn(iteration, {start, duration}));
        const lastSegment = placed.at(-1)!.at(-1)!;
        return {start, duration, segments: [...joined(placed, this.values), ...(next ? hold(lastSegment, 1, this.values) : [])]};
    }

    /** Its iteration at `index`, as a stretch: back to front, each segment flipped, every other one of an oscillation. */
    private iteration(index: number): Stretch {
        const flip = this.flipOf(index);
        const segments = flip ? this.segments.map(segment => segment.flip(flip)).reverse() : this.segments;
        return {start: this.iterationStartOf(index), duration: this.entry.iterationDuration, segments};
    }

    /** The value the iteration starts on. */
    private startValueOf({segments: [first]}: Stretch): string {
        return this.values.textAt(first!.stops, first!.startProgress);
    }

    /** The value the iteration ends on. */
    private endValueOf({segments}: Stretch): string {
        const last = segments.at(-1)!;
        return this.values.textAt(last.stops, last.endProgress);
    }

    /** The index of its iteration at `time`, or the one before it in a repeat delay, the first before it starts, or the last after it ends. */
    private iterationIndexAt(time: Seconds): number {
        const {start, iterationDuration, repeatDelay, repeatCount} = this.entry;
        return repeatCount === 0 ? 0 : clamp(Math.floor((time - start) / (iterationDuration + repeatDelay)), 0, repeatCount);
    }

    /** When its iteration at `index` starts. */
    private iterationStartOf(index: number): Seconds {
        return iterationStartOf(this.entry, index);
    }

    /** How long after its iteration at `index` starts what plays in it starts. */
    private playStartIn(index: number): Seconds {
        const {start, iterationDuration} = this.entry;
        return this.flipOf(index) ? start + iterationDuration - this.firstIterationEnd : this.start - start;
    }

    /** How long after its iteration at `index` starts what plays in it ends. */
    private playEndIn(index: number): Seconds {
        const {start, iterationDuration} = this.entry;
        return this.flipOf(index) ? start + iterationDuration - this.start : this.firstIterationEnd - start;
    }

    /** What its iteration at `index` flips: every other one of an oscillation does. */
    private flipOf(index: number): Oscillation | undefined {
        return flipOf(this.entry, index);
    }
}

/** When the item's last iteration ends, as the tracks stage works it out; `Infinity` when it never ends. */
export function endOf(item: TrackItem): Seconds {
    if (repeatsForever(item)) return Infinity;
    return iterationStartOf(item, item.repeatCount) + item.iterationDuration;
}

/** When the group's entries end in its last iteration, as the tracks stage works it out, from where they start and end in its first; `Infinity` when it never ends. */
function groupEndOf(group: TrackGroup, entriesStart: Seconds, entriesEnd: Seconds): Seconds {
    if (repeatsForever(group)) return Infinity;
    const {start, iterationDuration, repeatCount} = group;
    return iterationStartOf(group, repeatCount) + (flipOf(group, repeatCount) ? start + iterationDuration - entriesStart : entriesEnd - start);
}

/** When the entry's iteration at `index` starts. */
function iterationStartOf({start, iterationDuration, repeatDelay}: TrackEntry, index: number): Seconds {
    return start + index * (iterationDuration + repeatDelay);
}

/** What the entry's iteration at `index` flips: every other one of an oscillation does. */
function flipOf({oscillate}: TrackEntry, index: number): Oscillation | undefined {
    return index % 2 === 1 ? oscillate : undefined;
}

/** Backwards when it holds before, forwards when it holds after. */
function fillOf(holdsBefore: boolean, holdsAfter: boolean): FillMode {
    if (holdsBefore) return holdsAfter ? 'both' : 'backwards';
    return holdsAfter ? 'forwards' : 'none';
}

/** The stretch's segments in `time`: at the same moments, their offsets now fractions of it, which must have duration. */
function segmentsIn(stretch: Stretch, time: { start: Seconds; duration: Seconds }): Segment[] {
    const offsetOf = (offset: number) => (timeAt(stretch, offset) - time.start) / time.duration;
    return stretch.segments.map(segment => segment.move(offsetOf(segment.startOffset), offsetOf(segment.endOffset)));
}

/** Groups of segments placed in the same time, one after another, each one's end value held until the next starts. */
function joined(groups: readonly (readonly Segment[])[], values: TrackValues): Segment[] {
    return groups.flatMap((segments, index) => {
        const previous = groups[index - 1]?.at(-1);
        return previous ? [...hold(previous, segments[0]!.startOffset, values), ...segments] : [...segments];
    });
}

/**
 * The segments with `top`'s in place of their own for as long as `top` lasts, all placed in the same time,
 * or, when `top` starts where they end or later, followed by `top`'s, their end value held until then.
 */
function overlay(below: readonly Segment[], top: readonly Segment[], values: TrackValues): Segment[] {
    const start = below[0]!.startOffset;
    const end = below.at(-1)!.endOffset;
    const topStart = top[0]!.startOffset;
    if (topStart >= end) return joined([below, top], values);
    return [...trim(below, start, topStart), ...top, ...trim(below, top.at(-1)!.endOffset, end)];
}

/** The segments, each trimmed to `start` to `end` (`Segment.trim`). */
function trim(segments: readonly Segment[], start: number, end: number): Segment[] {
    return segments.flatMap(segment => segment.trim(start, end) ?? []);
}

/** The segment's end value held from where it ends until `end`, when there's time to hold it. */
function hold(segment: Segment, end: number, values: TrackValues): Segment[] {
    return end > segment.endOffset ? [Segment.holding(values.textAt(segment.stops, segment.endProgress), segment.endOffset, end)] : [];
}

/** The time at `offset` of the stretch, after the outermost definition starts. */
function timeAt({start, duration}: { start: Seconds; duration: Seconds }, offset: number): Seconds {
    return start + offset * duration;
}
