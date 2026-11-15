import type {CSSValue} from "../dom/mapping.ts";
import type {Easing} from "../easing.ts";
import type {TweenStops} from "../tween-stops.ts";
import type {Progress, Seconds} from "../types.ts";
import {getOrInsertComputed} from "../utils/collections.ts";
import {clamp} from "../utils/math.ts";
import {type Oscillation, repeatsForever, type TrackEntry, type TrackGroup, type TrackItem, type TrackStop, valueAtProgress} from "./track-entries.ts";
import {type CurrentValueToken, currentValueToken, type InterpolationToken, type TrackValue} from "./track-values.ts";

/** A missing value, until a value is assigned to it: every stop and token that has it then has that value. */
interface Placeholder {
    type: 'placeholder';
    value: PendingValue | undefined;
}

export type PendingValue = CSSValue | CurrentValueToken | Placeholder | InterpolationToken<PendingValue>;

/** Where a time falls in a run: in which iteration, how long after that iteration starts, and what that iteration flips. */
interface IterationTime {
    index: number;
    elapsed: Seconds;
    flip: Oscillation | undefined;
}

/**
 * A track's entry, built step by step: an item entry's run through its stops (`TrackItemBuilder`),
 * or a repeating sequence's run with the builders of the entries in it (`TrackGroupBuilder`).
 * Each missing value is a placeholder until a value is assigned to it. Then whether it holds before and after is set, and it builds into the track's entry.
 */
export abstract class TrackEntryBuilder {
    #holdsBefore = false;
    #holdsAfter = false;

    protected constructor(protected readonly name: string | undefined, protected readonly timing: TrackEntry) {}

    /** When it starts. */
    abstract get start(): Seconds;

    /** When its last iteration ends; `Infinity` when it never ends. */
    abstract get end(): Seconds;

    /** Whether it ends: it doesn't when it repeats forever. */
    get ends(): boolean {
        return !repeatsForever(this.timing);
    }

    /** Whether it runs at `time`: from its start, up to but not at its end. */
    runsAt(time: Seconds): boolean {
        return this.start <= time && time < this.end;
    }

    /** Whether it starts with or before `other`, and ends with or after it. */
    covers(other: TrackEntryBuilder): boolean {
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

    /** The value its first iteration starts on, which it shows before it starts. */
    get startValue(): PendingValue {
        return this.valueAt(-Infinity);
    }

    /** The value its last iteration ends on, which it shows once it's done; it must end. */
    get endValue(): PendingValue {
        this.requireEnd("end value");
        return this.valueAt(Infinity);
    }

    /**
     * The value at `time`: its iteration's then, held through the repeat delay after it, and the value it starts on before it, or ends on after it.
     * With `flipsValues`, the value it shows at the time that mirrors `time` in an iteration around it that flips its values:
     * it plays backwards there, but each animation in it runs from its end values to its start ones, its easing forwards.
     */
    abstract valueAt(time: Seconds, options?: { flipsValues?: boolean }): PendingValue;

    /** Gives a missing start `value`, unless `value` depends on it. */
    assignStartValueIfMissing(value: PendingValue): void {
        assignIfMissing(this.startValue, value);
    }

    /** Gives a missing end `value`, unless `value` depends on it; one that never ends has none to take. */
    assignEndValueIfMissing(value: PendingValue): void {
        if (this.ends) assignIfMissing(this.endValue, value);
    }

    /** A builder of its first iteration only, without repeats, with the same values, so a value assigned to one is the other's too. */
    withoutRepeats(): TrackEntryBuilder {
        const {oscillate: _, ...rest} = this.timing;
        return this.withTiming({...rest, repeatCount: 0, repeatDelay: 0});
    }

    /** Whether it holds the value it starts on before it starts. */
    get holdsBefore(): boolean {
        return this.#holdsBefore;
    }

    /** Whether it holds the value it ends on after it ends. */
    get holdsAfter(): boolean {
        return this.#holdsAfter;
    }

    /** Makes it hold the value it starts on before it starts. */
    holdBefore(): void {
        this.#holdsBefore = true;
    }

    /** Makes it hold the value it ends on after it ends. */
    holdAfter(): void {
        this.#holdsAfter = true;
    }

    /** The track's entry: each placeholder with its value, or the property's current value without one, and whether it holds before and after it. */
    abstract build(): TrackItem | TrackGroup;

    /** The same builder, with the same values, running as `timing` does. */
    protected abstract withTiming(timing: TrackEntry): TrackEntryBuilder;

    /** The index of its last iteration: its repeat count, `Infinity` when it repeats forever. */
    protected get lastIterationIndex(): number {
        return this.timing.repeatCount;
    }

    /** Where `time` falls: in its iteration then, or the one before it in a repeat delay, the first before it starts, or the last after it ends. */
    protected iterationTimeAt(time: Seconds): IterationTime {
        const {start, duration, repeatDelay} = this.timing;
        const index = this.lastIterationIndex === 0 ? 0 : clamp(Math.floor((time - start) / (duration + repeatDelay)), 0, this.lastIterationIndex);
        return {index, elapsed: time - this.iterationStartOf(index), flip: this.flipOf(index)};
    }

    /** When its iteration at `index` starts. */
    protected iterationStartOf(index: number): Seconds {
        const {start, duration, repeatDelay} = this.timing;
        return start + index * (duration + repeatDelay);
    }

    /** What its iteration at `index` flips: every other one of an oscillation does. */
    protected flipOf(index: number): Oscillation | undefined {
        return index % 2 === 1 ? this.timing.oscillate : undefined;
    }

    /** Throws when it never ends, so it has no `what`. */
    private requireEnd(what: string): void {
        if (!this.ends)
            throw new Error(`A track entry builder that repeats forever never ends, so it has no ${what}. Check \`ends\` first, or build it so it doesn't repeat forever.`);
    }
}

/** An item entry's run through its stops, by its easing. */
export class TrackItemBuilder extends TrackEntryBuilder {
    private constructor(
        name: string | undefined,
        timing: TrackEntry,
        private readonly easing: Easing,
        private readonly stops: readonly TrackStop<PendingValue>[]
    ) {
        super(name, timing);
    }

    /** An item entry's builder, each missing value a placeholder of its own. */
    static of(name: string | undefined, timing: TrackEntry, easing: Easing, stops: TweenStops): TrackItemBuilder {
        return new TrackItemBuilder(name, timing, easing, stops.stops.map(({offset, value}) => ({offset, value: value ?? placeholder()})));
    }

    get start(): Seconds {
        return this.timing.start;
    }

    get end(): Seconds {
        if (!this.ends) return Infinity;
        return this.iterationStartOf(this.lastIterationIndex) + this.timing.duration;
    }

    valueAt(time: Seconds, {flipsValues = false}: { flipsValues?: boolean } = {}): PendingValue {
        const {elapsed, flip} = this.iterationTimeAt(time);
        const {duration} = this.timing;
        const fraction = duration === 0 ? (elapsed >= 0 ? 1 : 0) : elapsed / duration;
        return this.valueAtFraction(flip ? 1 - fraction : fraction, flipsValues !== (flip === 'values'));
    }

    build(): TrackItem {
        const {name, timing, easing, stops, holdsBefore, holdsAfter} = this;
        const trackValuesByToken = new Map<InterpolationToken<PendingValue>, TrackValue>();
        const trackStops = stops.map(({offset, value}) => ({offset, value: trackValueOf(value, trackValuesByToken)}));
        return {type: 'item', name, ...timing, easing, stops: trackStops, holdsBefore, holdsAfter};
    }

    protected withTiming(timing: TrackEntry): TrackItemBuilder {
        return new TrackItemBuilder(this.name, timing, this.easing, this.stops);
    }

    /**
     * The value `fraction` of the way through an iteration that flips nothing: its start value before it, and its end value after it.
     * With `flipsValues`, the value at the time that mirrors it once its values flip: from its end values to its start ones, its easing forwards.
     */
    private valueAtFraction(fraction: number, flipsValues: boolean): PendingValue {
        const progress = flipsValues ? 1 - this.progressAt(1 - fraction) : this.progressAt(fraction);
        return valueAtProgress(this.stops, progress);
    }

    /** Its easing's progress `fraction` of the way through an iteration: its start progress before it, and its end progress after it. */
    private progressAt(fraction: number): Progress {
        const {easing} = this;
        if (fraction <= 0) return easing.startProgress;
        if (fraction >= 1) return easing.endProgress;
        return easing.progressAt(fraction);
    }
}

/**
 * A repeating sequence's run, with the builders of the entries in it: each of its iterations plays them as its first one does,
 * and every other one of an oscillation flips them. Its iteration's end value holds until its entries start in the next one.
 */
export class TrackGroupBuilder extends TrackEntryBuilder {
    private constructor(name: string | undefined, timing: TrackEntry, private readonly entries: readonly TrackEntryBuilder[]) {
        super(name, timing);
    }

    /**
     * A repeating sequence's builder, with `entries`: its entries' builders as they play in its first iteration, laid over each other in stacking order,
     * each over the ones before it, all of which show, with their holds. Throws without entries, or when one of them never ends.
     */
    static of(name: string | undefined, timing: TrackEntry, entries: readonly TrackEntryBuilder[]): TrackGroupBuilder {
        if (!entries.length)
            throw new Error("A repeating sequence's builder plays the entries in it in each of its iterations, but it was given none. Give it at least one.");
        if (!entries.every(entry => entry.ends))
            throw new Error("A repeating sequence's builder plays the entries in it in each of its iterations, so each one must end, but one of them repeats forever. Give it that one without its repeats.");
        return new TrackGroupBuilder(name, timing, entries);
    }

    /** When its first entry starts. */
    get start(): Seconds {
        return this.firstEntry.start;
    }

    /** When its entries end in its last iteration. */
    get end(): Seconds {
        if (!this.ends) return Infinity;
        const last = this.lastIterationIndex;
        return this.iterationStartOf(last) + this.entriesEndIn(this.flipOf(last));
    }

    valueAt(time: Seconds, {flipsValues = false}: { flipsValues?: boolean } = {}): PendingValue {
        const {index, elapsed, flip} = this.iterationTimeAt(time);
        if (index > 0 && elapsed < this.entriesStartIn(flip))
            return this.iterationEndValueAt(index - 1, flipsValues);
        if (elapsed >= this.entriesEndIn(flip))
            return this.iterationEndValueAt(index, flipsValues);
        const {start, duration} = this.timing;
        return this.entriesValueAt(start + (flip ? duration - elapsed : elapsed), flipsValues !== (flip === 'values'));
    }

    build(): TrackGroup {
        const {name, timing, entries, holdsBefore, holdsAfter} = this;
        return {type: 'group', name, ...timing, entries: entries.map(entry => entry.build()), holdsBefore, holdsAfter};
    }

    protected withTiming(timing: TrackEntry): TrackGroupBuilder {
        return new TrackGroupBuilder(this.name, timing, this.entries);
    }

    /** When the last of its entries ends in its first iteration. */
    private get entriesEnd(): Seconds {
        return Math.max(...this.entries.map(entry => entry.end));
    }

    /** How long after an iteration starts its entries start in it, when it flips as `flip` says. */
    private entriesStartIn(flip: Oscillation | undefined): Seconds {
        const {start, duration} = this.timing;
        return flip ? start + duration - this.entriesEnd : this.start - start;
    }

    /** How long after an iteration starts its entries end in it, when it flips as `flip` says. */
    private entriesEndIn(flip: Oscillation | undefined): Seconds {
        const {start, duration} = this.timing;
        return flip ? start + duration - this.start : this.entriesEnd - start;
    }

    /** The value its iteration at `index` ends on: what its entries show once they're all done, or, in a flipped iteration, before any of them starts. */
    private iterationEndValueAt(index: number, flipsValues: boolean): PendingValue {
        const flip = this.flipOf(index);
        return this.entriesValueAt(flip ? -Infinity : Infinity, flipsValues !== (flip === 'values'));
    }

    /** The value its entries show at `time` in its first iteration, through the one that shows then. */
    private entriesValueAt(time: Seconds, flipsValues: boolean): PendingValue {
        return this.entryShowingAt(time).valueAt(time, {flipsValues});
    }

    /** The entry that shows at `time` in its first iteration: the topmost one running then, otherwise the one it holds the end value of, otherwise, before them, the first. */
    private entryShowingAt(time: Seconds): TrackEntryBuilder {
        return this.entries.findLast(entry => entry.runsAt(time)) ?? this.entryHeldAt(time) ?? this.firstEntry;
    }

    /** The entry whose end value it holds at `time` in its first iteration: the latest to end by then of the ones that hold after, the topmost of ties. */
    private entryHeldAt(time: Seconds): TrackEntryBuilder | undefined {
        return this.entries
            .filter(entry => entry.holdsAfter && entry.end <= time)
            .reduce<TrackEntryBuilder | undefined>((held, entry) => !held || entry.end >= held.end ? entry : held, undefined);
    }

    /** The topmost of its entries that start first. */
    private get firstEntry(): TrackEntryBuilder {
        return this.entries.reduce((first, entry) => entry.start <= first.start ? entry : first);
    }
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
