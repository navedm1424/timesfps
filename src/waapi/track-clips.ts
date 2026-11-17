import type {Easing} from "../easing.ts";
import {linear} from "../easing-specifier.ts";
import type {Oscillation} from "../playback-options.ts";
import type {Progress, Seconds} from "../types.ts";
import {invLerp, remap} from "../utils/math.ts";
import {type TrackEntry, type TrackGroup, type TrackItem, type TrackStop, valueAtProgress} from "../tracks/track-entries.ts";
import type {InterpolationToken, TrackValue} from "../tracks/track-values.ts";

/**
 * Stops played through an easing, over a window of its input time, and placed in time: `startOffset` to `endOffset` are fractions of the time
 * it's placed in, a run's iteration or a part, and `windowStart` to `windowEnd` fractions of its easing's input time, which runs backwards when its end comes first.
 */
export class TrackClip<Value> {
    /** Its easing over its window, which keeps its easing's progress. */
    readonly windowedEasing: Easing;

    constructor(
        readonly startOffset: number,
        readonly endOffset: number,
        readonly easing: Easing,
        /** Its values at offsets of its easing's progress, in order, as `valueAtProgress` reads them. */
        readonly stops: readonly TrackStop<Value>[],
        readonly windowStart: number = 0,
        readonly windowEnd: number = 1
    ) {
        this.windowedEasing = easing.segment(windowStart, windowEnd);
    }

    /** Whether it starts and ends at the same offset, so its value jumps there. */
    get isJump(): boolean {
        return this.startOffset === this.endOffset;
    }

    /** The value at the progress its window starts from. */
    get startValue(): Value | InterpolationToken<Value> {
        return this.valueAtProgress(this.windowedEasing.startProgress);
    }

    /** The value at the progress its window ends at. */
    get endValue(): Value | InterpolationToken<Value> {
        return this.valueAtProgress(this.windowedEasing.endProgress);
    }

    /** The value at `offset` of the time it's placed in: its start value before it, and its end value after it, or where it starts and ends at once. */
    valueAt(offset: number): Value | InterpolationToken<Value> {
        const {startOffset, endOffset, windowedEasing} = this;
        if (offset >= endOffset) return this.endValue;
        if (offset <= startOffset) return this.startValue;
        return this.valueAtProgress(windowedEasing.progressAt(invLerp(startOffset, endOffset, offset)));
    }

    /** Its stops' value at `progress` (`valueAtProgress`). */
    valueAtProgress(progress: Progress): Value | InterpolationToken<Value> {
        return valueAtProgress(this.stops, progress);
    }

    /** The stops strictly between the two progresses, in either order. */
    stopsBetween(fromProgress: Progress, toProgress: Progress): TrackStop<Value>[] {
        const lowest = Math.min(fromProgress, toProgress);
        const highest = Math.max(fromProgress, toProgress);
        return this.stops.filter(({offset}) => offset > lowest && offset < highest);
    }

    /**
     * What of it plays from `start` to `end` of the time it's placed in, its window narrowed to it; undefined when none of it does.
     * A jump stays when it's from `start` up to, but not at, `end`.
     */
    trim(start: number, end: number): TrackClip<Value> | undefined {
        const {startOffset, endOffset, windowStart, windowEnd} = this;
        if (this.isJump) return startOffset >= start && startOffset < end ? this : undefined;
        const trimmedStart = Math.max(startOffset, start);
        const trimmedEnd = Math.min(endOffset, end);
        if (trimmedEnd <= trimmedStart) return undefined;
        if (trimmedStart === startOffset && trimmedEnd === endOffset) return this;

        function windowAt(offset: number) {
            return remap(offset, startOffset, endOffset, windowStart, windowEnd);
        }
        return new TrackClip(trimmedStart, trimmedEnd, this.easing, this.stops, windowAt(trimmedStart), windowAt(trimmedEnd));
    }

    /**
     * The same clip in the iteration flipped by `oscillate`, from 1 minus its end to 1 minus its start: flipping its time runs its window backwards,
     * and flipping its values mirrors its window too, so its easing still runs forwards, and moves each stop from its offset to 1 minus it.
     */
    flip(oscillate: Oscillation): TrackClip<Value> {
        const {startOffset, endOffset, easing, stops, windowStart, windowEnd} = this;
        return oscillate === 'time'
            ? new TrackClip(1 - endOffset, 1 - startOffset, easing, stops, windowEnd, windowStart)
            : new TrackClip(1 - endOffset, 1 - startOffset, easing, stops.map(({offset, value}) => ({offset: 1 - offset, value})).reverse(), 1 - windowEnd, 1 - windowStart);
    }

    /** The same clip from `startOffset` to `endOffset`. */
    move(startOffset: number, endOffset: number): TrackClip<Value> {
        const {easing, stops, windowStart, windowEnd} = this;
        return new TrackClip(startOffset, endOffset, easing, stops, windowStart, windowEnd);
    }
}

/** A stretch of a track and the clips in it: when it starts after the outermost definition starts, how long it lasts, and its clips, one after another without gaps, their offsets fractions of it. */
export interface TrackRunPart<Value> {
    start: Seconds;
    duration: Seconds;
    clips: readonly TrackClip<Value>[];
}

/**
 * A track's entry as one run of clips: its clips, one iteration of it, repeated as its timing says,
 * and whether it holds its value before it starts and after it ends.
 */
export class TrackRun<Value> {
    /** `clips` are one after another without gaps, their offsets fractions of its iteration. Throws without clips. */
    constructor(
        readonly name: string | undefined,
        readonly timing: TrackEntry,
        readonly clips: readonly TrackClip<Value>[],
        /** Whether it holds the value it starts on before it starts. */
        readonly holdsBefore: boolean,
        /** Whether it holds the value it ends on once it's done. */
        readonly holdsAfter: boolean
    ) {
        if (!clips.length)
            throw new Error("A track run has at least one clip, but it was given none. Give it the clips of its iteration.");
    }

    /** Its iterations from `first` to `last`, as `partOf` lays them out. */
    part(first: number, last: number, options: { holdsUntilNext?: boolean } = {}): TrackRunPart<Value | InterpolationToken<Value>> {
        return partOf(this.timing, this.clips, first, last, options);
    }
}

/**
 * The entry as one run of clips: an item's iteration is one clip through its stops,
 * and a repeating group's is the iterations of its entries, laid out and laid over each other in it (`groupClipsOf`).
 */
export function trackRunOf(entry: TrackItem | TrackGroup): TrackRun<TrackValue> {
    const {name, start, iterationDuration, repeatCount, repeatDelay, oscillate, holdsBefore, holdsAfter} = entry;
    const timing: TrackEntry = {start, iterationDuration, repeatCount, repeatDelay, ...(oscillate && {oscillate})};
    return new TrackRun(name, timing, iterationClipsOf(entry), holdsBefore, holdsAfter);
}

/** The clips of the entry's iteration, their offsets fractions of it. */
function iterationClipsOf(entry: TrackItem | TrackGroup): TrackClip<TrackValue>[] {
    return entry.type === 'item' ? [new TrackClip(0, 1, entry.easing, entry.stops)] : groupClipsOf(entry);
}

/**
 * A repeating group's iteration: each entry's iterations, one after another, in the group's iteration as fractions of it, laid over each other in stacking order.
 * One that starts within the ones before it replaces them while it lasts; one that starts where they end, or later, follows them, their end value held until then.
 * Throws without entries, when its iteration has no duration, or when one of its entries holds before.
 */
function groupClipsOf(group: TrackGroup): TrackClip<TrackValue>[] {
    if (!group.entries.length)
        throw new Error("A repeating sequence's iteration lays out the entries in it, but it was given none. Give it at least one.");
    if (!(group.iterationDuration > 0))
        throw new Error(`A repeating sequence's iteration places the entries in it as fractions of its duration, which is ${group.iterationDuration}. Give it an iteration that lasts some time; one without duration never repeats.`);
    if (group.entries.some(entry => entry.holdsBefore))
        throw new Error("WAAPI doesn't hold an entry of a repeating sequence before it starts, but one of them holds before. Hold none of a repeating sequence's entries before.");

    const iteration = {start: group.start, duration: group.iterationDuration};
    const [first, ...rest] = group.entries.map(entry => clipsIn(layOutIterations(entry), iteration));
    return rest.reduce(overlayClips, first!);
}

/** All of the entry's iterations, one after another; it must end. */
function layOutIterations(entry: TrackItem | TrackGroup): TrackRunPart<TrackValue> {
    if (entry.repeatCount === Infinity)
        throw new Error("WAAPI lays out every iteration of an entry of a repeating sequence, but one of them repeats forever. Give the sequence that one without its repeats.");
    return partOf(entry, iterationClipsOf(entry), 0, entry.repeatCount);
}

/**
 * A run's iterations from `first` to `last`, one after another, each one's end value held until the next starts, as a part from where its first clip starts
 * to where its last one ends, 0 to 1; with `holdsUntilNext`, the last one's is held too, until the iteration after it would start. `clips` are one iteration.
 * A part without duration keeps its clips' offsets in their iteration.
 * Every other iteration of an oscillation is laid out back to front, each clip flipped (`TrackClip.flip`).
 * Throws without clips, or for iterations the run doesn't have.
 */
function partOf<Value>(
    timing: TrackEntry,
    clips: readonly TrackClip<Value>[],
    first: number,
    last: number,
    {holdsUntilNext = false}: { holdsUntilNext?: boolean } = {}
): TrackRunPart<Value | InterpolationToken<Value>> {
    const {repeatCount} = timing;
    if (!clips.length)
        throw new Error("A run's iterations are laid out from its clips, but it was given none. Give it the clips of its iteration.");
    if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || first > last || last > repeatCount)
        throw new Error(`A run's iterations are 0 to its repeat count, ${repeatCount}, but iterations ${first} to ${last} were asked for. Ask for whole iterations within that range, the first one no later than the last.`);

    const iterations = Array.from({length: last - first + 1}, (_, index) => iterationAt(timing, clips, first + index));
    const firstIteration = iterations[0]!;
    const lastIteration = iterations.at(-1)!;
    const next = holdsUntilNext ? iterationAt(timing, clips, last + 1) : undefined;
    const start = timeAt(firstIteration, firstIteration.clips[0]!.startOffset);
    const end = next ? timeAt(next, next.clips[0]!.startOffset) : timeAt(lastIteration, lastIteration.clips.at(-1)!.endOffset);
    const duration = end - start;
    if (duration === 0) return {start, duration, clips: firstIteration.clips};

    const placed = iterations.map(iteration => clipsIn(iteration, {start, duration}));
    const lastClip = placed.at(-1)!.at(-1)!;
    return {start, duration, clips: [...joinClips(placed), ...(next ? holdClips(lastClip.endValue, lastClip.endOffset, 1) : [])]};
}

/** The laid-out clips in `time`: at the same moments, their offsets now fractions of it, which must have duration. */
function clipsIn<Value>(laidOut: TrackRunPart<Value>, time: { start: Seconds; duration: Seconds }): TrackClip<Value>[] {
    const offsetOf = (offset: number) => (timeAt(laidOut, offset) - time.start) / time.duration;
    return laidOut.clips.map(clip => clip.move(offsetOf(clip.startOffset), offsetOf(clip.endOffset)));
}

/** Groups of clips placed in the same time, one after another, each one's end value held until the next starts. */
function joinClips<Value>(groups: readonly (readonly TrackClip<Value>[])[]): TrackClip<Value | InterpolationToken<Value>>[] {
    return groups.flatMap((clips, index): TrackClip<Value | InterpolationToken<Value>>[] => {
        const previous = groups[index - 1]?.at(-1);
        return previous ? [...holdClips(previous.endValue, previous.endOffset, clips[0]!.startOffset), ...clips] : [...clips];
    });
}

/**
 * The clips with `top`'s in place of their own for as long as `top` lasts, all placed in the same time,
 * or, when `top` starts where they end or later, followed by `top`'s, their end value held until then.
 */
function overlayClips(below: readonly TrackClip<TrackValue>[], top: readonly TrackClip<TrackValue>[]): TrackClip<TrackValue>[] {
    const start = below[0]!.startOffset;
    const end = below.at(-1)!.endOffset;
    const topStart = top[0]!.startOffset;
    if (topStart >= end) return joinClips([below, top]);
    return [...trimClips(below, start, topStart), ...top, ...trimClips(below, top.at(-1)!.endOffset, end)];
}

/** The clips, each trimmed to `start` to `end` (`TrackClip.trim`). */
function trimClips(clips: readonly TrackClip<TrackValue>[], start: number, end: number): TrackClip<TrackValue>[] {
    return clips.flatMap(clip => clip.trim(start, end) ?? []);
}

/** The iteration at `index`, as a part: back to front, each clip flipped, every other one of an oscillation. */
function iterationAt<Value>({start, iterationDuration, repeatDelay, oscillate}: TrackEntry, clips: readonly TrackClip<Value>[], index: number): TrackRunPart<Value> {
    const iterationClips = index % 2 === 0 || !oscillate ? clips : clips.map(clip => clip.flip(oscillate)).reverse();
    return {start: start + index * (iterationDuration + repeatDelay), duration: iterationDuration, clips: iterationClips};
}

/** The time at `offset` of the part, after the outermost definition starts. */
function timeAt({start, duration}: TrackRunPart<unknown>, offset: number): Seconds {
    return start + offset * duration;
}

/** A clip holding `value` from `start` to `end`, when there's time to hold it. */
function holdClips<Value>(value: Value, start: number, end: number): TrackClip<Value>[] {
    return end > start ? [new TrackClip(start, end, linear, [{offset: 0, value}, {offset: 1, value}])] : [];
}
