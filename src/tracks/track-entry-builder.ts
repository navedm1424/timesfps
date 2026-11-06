import type {CSSValue} from "../dom/mapping.ts";
import type {Easing} from "../easing.ts";
import type {TweenStops} from "../tween-stops.ts";
import type {Seconds} from "../types.ts";
import {getOrInsertComputed} from "../utils/collections.ts";
import {clamp} from "../utils/math.ts";
import {KeyedRamp, TrackStops} from "./keyed-ramps.ts";
import {repeatsForever, type TrackEntry, type TrackRunTiming} from "./track-entries.ts";
import {type CurrentValueToken, currentValueToken, type InterpolatedValueToken, type TrackValue} from "./track-values.ts";

/** A missing value, until a value is assigned to it: every span and token that has it then has that value. */
interface Placeholder {
    type: 'placeholder';
    value: PendingValue | undefined;
}

export type PendingValue = CSSValue | CurrentValueToken | Placeholder | InterpolatedValueToken<PendingValue>;

/**
 * A track entry, built step by step: an iteration that repeats as its timing does, which is an entry's iteration, or a repeating sequence's iteration with its children merged into it.
 * Each missing value is a placeholder until a value is assigned to it. Then whether it holds before and after is set, and it builds into the track entry.
 */
export class TrackEntryBuilder {
    private holdsBefore = false;
    private holdsAfter = false;

    /** `keyedRamp` is from the timing's start. */
    private constructor(
        private readonly name: string | undefined,
        private readonly timing: TrackRunTiming,
        private readonly keyedRamp: KeyedRamp<PendingValue>
    ) {}

    /** An entry's iteration through its stops, each missing value a placeholder of its own. */
    static fromStops(name: string | undefined, timing: TrackRunTiming, easing: Easing, stops: TweenStops): TrackEntryBuilder {
        return new TrackEntryBuilder(name, timing, KeyedRamp.ofSpan(timing.duration, easing, new TrackStops(stops.stops).map(value => value ?? placeholder())));
    }

    /** A repeating sequence's iteration, its children merged into it, `keyedRamp` after the outermost definition starts. */
    static merged(name: string | undefined, timing: TrackRunTiming, keyedRamp: KeyedRamp<PendingValue>): TrackEntryBuilder {
        return new TrackEntryBuilder(name, timing, keyedRamp.shifted(-timing.start));
    }

    /** When its first iteration starts. */
    get start(): Seconds {
        return this.timing.start + this.keyedRamp.start;
    }

    /** Whether it ends: it doesn't when it repeats forever. */
    get ends(): boolean {
        return !repeatsForever(this.timing);
    }

    /** When its last iteration ends; `Infinity` when it never ends. */
    get end(): Seconds {
        return this.ends ? this.iterationOf(this.lastIterationIndex).end : Infinity;
    }

    /** Whether it runs at `time`: from its start, up to but not at its end. */
    runsAt(time: Seconds): boolean {
        return this.start <= time && time < this.end;
    }

    /** Whether it starts with or before `other`, and ends with or after it. */
    covers(other: TrackEntryBuilder): boolean {
        return this.start <= other.start && other.end <= this.end;
    }

    /** Its iterations one after another; it must end. */
    get laidOut(): KeyedRamp<PendingValue> {
        this.requireEnd("iterations to lay out one after another");
        return KeyedRamp.joined(Array.from({length: this.lastIterationIndex + 1}, (_, index) => this.iterationOf(index)));
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
        return this.keyedRamp.startValue;
    }

    /** The value its last iteration ends on; it must end. */
    get endValue(): PendingValue {
        this.requireEnd("end value");
        return this.iterationOf(this.lastIterationIndex).endValue;
    }

    /** The value at `time`: its iteration's then, held through the repeat delay after it, and the value it starts on before it, or ends on after it. */
    valueAt(time: Seconds): PendingValue {
        const {start, duration, repeatDelay} = this.timing;
        const index = this.lastIterationIndex === 0 ? 0 : clamp(Math.floor((time - start) / (duration + repeatDelay)), 0, this.lastIterationIndex);
        return this.iterationOf(index).valueAt(time);
    }

    /** Gives a missing start `value`, unless `value` is made from it. */
    assignStartValueIfMissing(value: PendingValue): void {
        assignIfMissing(this.startValue, value);
    }

    /** Gives a missing end `value`, unless `value` is made from it; it must end. */
    assignEndValueIfMissing(value: PendingValue): void {
        assignIfMissing(this.endValue, value);
    }

    /** Makes it hold the value it starts on before it starts. */
    holdBefore(): void {
        this.holdsBefore = true;
    }

    /** Makes it hold the value it ends on after it ends. */
    holdAfter(): void {
        this.holdsAfter = true;
    }

    /** The track entry: its run, its iteration as its keyed ramp, each placeholder with its value, or the property's current value without one, and whether it holds before and after it. */
    build(): TrackEntry {
        const {name, timing: {start, duration, repeatCount, repeatDelay, oscillate}, holdsBefore, holdsAfter} = this;
        const resolvedTokens = new Map<InterpolatedValueToken<PendingValue>, TrackValue>();
        const keyedRamp = this.keyedRamp.map(value => resolvedValueOf(value, resolvedTokens));
        return {name, start, duration, repeatCount, repeatDelay, ...(oscillate && {oscillate}), keyedRamp, holdsBefore, holdsAfter};
    }

    /** The index of its last iteration: its repeat count, `Infinity` when it repeats forever. */
    private get lastIterationIndex(): number {
        return this.timing.repeatCount;
    }

    /** Throws when it never ends, so it has no `what`. */
    private requireEnd(what: string): void {
        if (!this.ends)
            throw new Error(`A track entry builder that repeats forever never ends, so it has no ${what}. Check \`ends\` first, or build it so it doesn't repeat forever.`);
    }

    /** Its iteration at `index`, from the timing's start. */
    private iterationOf(index: number): KeyedRamp<PendingValue> {
        const {start, duration, repeatDelay, oscillate} = this.timing;
        return this.keyedRamp.iteration(index, duration, repeatDelay, oscillate).shifted(start);
    }
}

function placeholder(): Placeholder {
    return {type: 'placeholder', value: undefined};
}

function isPlaceholder(value: PendingValue): value is Placeholder {
    return typeof value === 'object' && value.type === 'placeholder';
}

/** The placeholder without a value that `value` comes to, through the placeholders it has. */
function unassignedPlaceholderOf(value: PendingValue): Placeholder | undefined {
    if (!isPlaceholder(value)) return undefined;
    return value.value === undefined ? value : unassignedPlaceholderOf(value.value);
}

function isMissing(value: PendingValue): boolean {
    return unassignedPlaceholderOf(value) !== undefined;
}

/** Gives `value` to the placeholder without a value that `pending` comes to, if there's one, unless `value` is made from it. */
function assignIfMissing(pending: PendingValue, value: PendingValue): void {
    const unassigned = unassignedPlaceholderOf(pending);
    if (unassigned && !isMadeFrom(value, unassigned)) unassigned.value = value;
}

/** Whether `value` is the placeholder, or comes to it through placeholders and the ends of interpolated values. */
function isMadeFrom(value: PendingValue, unassigned: Placeholder): boolean {
    if (value === unassigned) return true;
    if (typeof value !== 'object' || value.type === 'currentValue') return false;
    if (value.type === 'placeholder') return value.value !== undefined && isMadeFrom(value.value, unassigned);
    return isMadeFrom(value.from, unassigned) || isMadeFrom(value.to, unassigned);
}

/** The value with each placeholder's value, and the property's current value for each one without; an interpolated value resolves once. */
function resolvedValueOf(value: PendingValue, resolvedTokens: Map<InterpolatedValueToken<PendingValue>, TrackValue>): TrackValue {
    if (isPlaceholder(value)) return value.value === undefined ? currentValueToken : resolvedValueOf(value.value, resolvedTokens);
    if (typeof value !== 'object' || value.type === 'currentValue') return value;

    return getOrInsertComputed(resolvedTokens, value, () => ({...value, from: resolvedValueOf(value.from, resolvedTokens), to: resolvedValueOf(value.to, resolvedTokens)}));
}
