import type {CSSValue} from "../dom/mapping.ts";
import type {Easing} from "../easing.ts";
import type {TweenStops} from "../tween-stops.ts";
import type {Seconds} from "../types.ts";
import {getOrInsertComputed} from "../utils/collections.ts";
import {clamp} from "../utils/math.ts";
import {joinClips, moveClips, partOf, repeatsForever, TrackClip, type TrackEntry, TrackRun, type TrackRunPart} from "./track-runs.ts";
import {type CurrentValueToken, currentValueToken, type InterpolationToken, type TrackValue} from "./track-values.ts";

/** A missing value, until a value is assigned to it: every clip and token that has it then has that value. */
interface Placeholder {
    type: 'placeholder';
    value: PendingValue | undefined;
}

export type PendingValue = CSSValue | CurrentValueToken | Placeholder | InterpolationToken<PendingValue>;

/**
 * A track run, built step by step: an entry's iteration, or a repeating sequence's iteration with its children merged into it, that repeats as its timing does.
 * Each missing value is a placeholder until a value is assigned to it. Then whether it holds before and after is set, and it builds into the track run.
 */
export class TrackRunBuilder {
    private holdsBefore = false;
    private holdsAfter = false;

    /** `clips` are its iteration, one after another without gaps, their offsets fractions of it. */
    private constructor(
        private readonly name: string | undefined,
        private readonly timing: TrackEntry,
        private readonly clips: readonly TrackClip<PendingValue>[]
    ) {}

    /** An entry's iteration through its stops, each missing value a placeholder of its own. */
    static fromStops(name: string | undefined, timing: TrackEntry, easing: Easing, stops: TweenStops): TrackRunBuilder {
        const clipStops = stops.stops.map(({offset, value}) => ({offset, value: value ?? placeholder()}));
        return new TrackRunBuilder(name, timing, [new TrackClip(0, 1, easing, clipStops)]);
    }

    /**
     * A repeating sequence's iteration, the iterations of `children` merged into it in stacking order, each over the ones before it.
     * One that starts within the ones before it replaces them while it lasts; one that starts where they end, or later, follows them, their end value held until then.
     * Throws without children, or when `timing` has no duration; each one must end.
     */
    static fromChildren(name: string | undefined, timing: TrackEntry, children: readonly TrackRunBuilder[]): TrackRunBuilder {
        if (!children.length)
            throw new Error("A repeating sequence's iteration merges the iterations of the runs in it, but it was given none. Merge at least one.");
        if (!(timing.duration > 0))
            throw new Error(`A repeating sequence's iteration places the runs in it as fractions of its duration, which is ${timing.duration}. Merge them into an iteration that lasts some time; one without duration never repeats.`);
        const [first, ...rest] = children.map(child => {
            child.requireEnd("iterations to merge");
            return moveClips(child.part(0, child.lastIterationIndex), timing.start, timing.duration);
        });
        return new TrackRunBuilder(name, timing, rest.reduce(overlayClips, first!));
    }

    /** When its first iteration starts. */
    get start(): Seconds {
        return this.iterationAt(0).start;
    }

    /** Whether it ends: it doesn't when it repeats forever. */
    get ends(): boolean {
        return !repeatsForever(this.timing);
    }

    /** When its last iteration ends; `Infinity` when it never ends. */
    get end(): Seconds {
        if (!this.ends) return Infinity;
        const {start, duration} = this.iterationAt(this.lastIterationIndex);
        return start + duration;
    }

    /** Whether it runs at `time`: from its start, up to but not at its end. */
    runsAt(time: Seconds): boolean {
        return this.start <= time && time < this.end;
    }

    /** Whether it starts with or before `other`, and ends with or after it. */
    covers(other: TrackRunBuilder): boolean {
        return this.start <= other.start && other.end <= this.end;
    }

    /** Whether the value it starts on is missing. */
    get hasMissingStartValue(): boolean {
        return isMissing(this.startValue);
    }

    /** Whether the value it ends on is missing; one that never ends has none to take. */
    get hasMissingEndValue(): boolean {
        return this.ends && isMissing(this.endValue);
    }

    /** The value its first iteration starts on. */
    get startValue(): PendingValue {
        return this.clips[0]!.startValue;
    }

    /** The value its last iteration ends on; it must end. */
    get endValue(): PendingValue {
        this.requireEnd("end value");
        return this.iterationAt(this.lastIterationIndex).clips.at(-1)!.endValue;
    }

    /** The value at `time`: its iteration's then, held through the repeat delay after it, and the value it starts on before it, or ends on after it. */
    valueAt(time: Seconds): PendingValue {
        const {start, duration, repeatDelay} = this.timing;
        const index = this.lastIterationIndex === 0 ? 0 : clamp(Math.floor((time - start) / (duration + repeatDelay)), 0, this.lastIterationIndex);
        return valueAtTimeOf(this.iterationAt(index), time);
    }

    /** Gives a missing start `value`, unless `value` depends on it. */
    assignStartValueIfMissing(value: PendingValue): void {
        assignIfMissing(this.startValue, value);
    }

    /** Gives a missing end `value`, unless `value` depends on it; one that never ends has none to take. */
    assignEndValueIfMissing(value: PendingValue): void {
        if (this.ends) assignIfMissing(this.endValue, value);
    }

    /** Itself when it ends; otherwise a builder of its first iteration only, without repeats, with the same values, so a value assigned to one is the other's too. */
    withoutRepeats(): TrackRunBuilder {
        const {oscillate: _, ...rest} = this.timing;
        return new TrackRunBuilder(this.name, {...rest, repeatCount: 0, repeatDelay: 0}, this.clips);
    }

    /** Makes it hold the value it starts on before it starts. */
    holdBefore(): void {
        this.holdsBefore = true;
    }

    /** Makes it hold the value it ends on after it ends. */
    holdAfter(): void {
        this.holdsAfter = true;
    }

    /** The track run: each placeholder with its value, or the property's current value without one, and whether it holds before and after it. */
    build(): TrackRun<TrackValue> {
        const trackValuesByToken = new Map<InterpolationToken<PendingValue>, TrackValue>();
        const clips = this.clips.map(clip => clip.map(value => trackValueOf(value, trackValuesByToken)));
        return new TrackRun(this.name, this.timing, clips, this.holdsBefore, this.holdsAfter);
    }

    /** The index of its last iteration: its repeat count, `Infinity` when it repeats forever. */
    private get lastIterationIndex(): number {
        return this.timing.repeatCount;
    }

    /** Throws when it never ends, so it has no `what`. */
    private requireEnd(what: string): void {
        if (!this.ends)
            throw new Error(`A track run builder that repeats forever never ends, so it has no ${what}. Check \`ends\` first, or build it so it doesn't repeat forever.`);
    }

    /** Its iterations from `first` to `last`, one after another. */
    private part(first: number, last: number): TrackRunPart<PendingValue> {
        return partOf(this.timing, this.clips, first, last);
    }

    /** Its iteration at `index`. */
    private iterationAt(index: number): TrackRunPart<PendingValue> {
        return this.part(index, index);
    }
}

/** The value of the part at `time`, which is the next clip's start where two meet. */
function valueAtTimeOf({start, duration, clips}: TrackRunPart<PendingValue>, time: Seconds): PendingValue {
    const offset = duration === 0 ? (time >= start ? Infinity : -Infinity) : (time - start) / duration;
    const clip = clips.findLast(clip => clip.startOffset <= offset) ?? clips[0]!;
    return clip.valueAt(offset);
}

/**
 * The clips with `top`'s in place of their own for as long as `top` lasts, all placed in the same time,
 * or, when `top` starts where they end or later, followed by `top`'s, their end value held until then.
 */
function overlayClips(below: readonly TrackClip<PendingValue>[], top: readonly TrackClip<PendingValue>[]): TrackClip<PendingValue>[] {
    const start = below[0]!.startOffset;
    const end = below.at(-1)!.endOffset;
    const topStart = top[0]!.startOffset;
    if (topStart >= end) return joinClips([below, top]);
    return [...trimClips(below, start, topStart), ...top, ...trimClips(below, top.at(-1)!.endOffset, end)];
}

/** The clips, each trimmed to `start` to `end` (`TrackClip.trim`). */
function trimClips(clips: readonly TrackClip<PendingValue>[], start: number, end: number): TrackClip<PendingValue>[] {
    return clips.flatMap(clip => clip.trim(start, end) ?? []);
}

function placeholder(): Placeholder {
    return {type: 'placeholder', value: undefined};
}

function isPlaceholder(value: PendingValue): value is Placeholder {
    return typeof value === 'object' && value.type === 'placeholder';
}

/** The placeholder without a value that `value` comes to, through the placeholders it has. */
function missingValueOf(value: PendingValue): Placeholder | undefined {
    if (!isPlaceholder(value)) return undefined;
    return value.value === undefined ? value : missingValueOf(value.value);
}

function isMissing(value: PendingValue): boolean {
    return missingValueOf(value) !== undefined;
}

/** Gives `value` to the placeholder without a value that `pending` comes to, if there's one, unless `value` depends on it. */
function assignIfMissing(pending: PendingValue, value: PendingValue): void {
    const missing = missingValueOf(pending);
    if (missing && !dependsOn(value, missing)) missing.value = value;
}

/** Whether `value` is the placeholder, or comes to it through placeholders and the ends of interpolated values. */
function dependsOn(value: PendingValue, missing: Placeholder): boolean {
    if (value === missing) return true;
    if (typeof value !== 'object' || value.type === 'currentValue') return false;
    if (value.type === 'placeholder') return value.value !== undefined && dependsOn(value.value, missing);
    return dependsOn(value.from, missing) || dependsOn(value.to, missing);
}

/** The value with each placeholder's value, and the property's current value for each one without; an interpolated value resolves once. */
function trackValueOf(value: PendingValue, trackValuesByToken: Map<InterpolationToken<PendingValue>, TrackValue>): TrackValue {
    if (isPlaceholder(value)) return value.value === undefined ? currentValueToken : trackValueOf(value.value, trackValuesByToken);
    if (typeof value !== 'object' || value.type === 'currentValue') return value;

    return getOrInsertComputed(trackValuesByToken, value, () => ({...value, from: trackValueOf(value.from, trackValuesByToken), to: trackValueOf(value.to, trackValuesByToken)}));
}
