import type {Easing} from "../easing.ts";
import type {Oscillation} from "../playback-options.ts";
import type {TweenStops} from "../tween-stops.ts";
import type {Seconds} from "../types.ts";
import {repeatsForever, type TrackEntry, type TrackGroup, type TrackItem, type TrackStop} from "./track-entries.ts";

/**
 * A track's entry, built step by step: an item entry's run through its stops (`TrackItemBuilder`),
 * or a repeating sequence's run with the builders of the entries in it (`TrackGroupBuilder`).
 * Once whether it holds before and after is set, it builds into the track's entry.
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

    /** A builder of its first iteration only, without repeats, with the same values. */
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

    /** The track's entry, with whether it holds before and after it. */
    abstract build(): TrackItem | TrackGroup;

    /** The same builder, with the same values, running as `timing` does. */
    protected abstract withTiming(timing: TrackEntry): TrackEntryBuilder;

    /** The index of its last iteration: its repeat count, `Infinity` when it repeats forever. */
    protected get lastIterationIndex(): number {
        return this.timing.repeatCount;
    }

    /** When its iteration at `index` starts. */
    protected iterationStartOf(index: number): Seconds {
        const {start, iterationDuration, repeatDelay} = this.timing;
        return start + index * (iterationDuration + repeatDelay);
    }

    /** What its iteration at `index` flips: every other one of an oscillation does. */
    protected flipOf(index: number): Oscillation | undefined {
        return index % 2 === 1 ? this.timing.oscillate : undefined;
    }
}

/** An item entry's run through its stops, by its easing. */
export class TrackItemBuilder extends TrackEntryBuilder {
    private constructor(
        name: string | undefined,
        timing: TrackEntry,
        private readonly easing: Easing,
        private readonly stops: readonly TrackStop[]
    ) {
        super(name, timing);
    }

    /** An item entry's builder. */
    static of(name: string | undefined, timing: TrackEntry, easing: Easing, stops: TweenStops): TrackItemBuilder {
        return new TrackItemBuilder(name, timing, easing, stops.stops);
    }

    get start(): Seconds {
        return this.timing.start;
    }

    get end(): Seconds {
        if (!this.ends) return Infinity;
        return this.iterationStartOf(this.lastIterationIndex) + this.timing.iterationDuration;
    }

    build(): TrackItem {
        const {name, timing, end, easing, stops, holdsBefore, holdsAfter} = this;
        return {type: 'item', name, ...timing, end, easing, stops, holdsBefore, holdsAfter};
    }

    protected withTiming(timing: TrackEntry): TrackItemBuilder {
        return new TrackItemBuilder(this.name, timing, this.easing, this.stops);
    }
}

/**
 * A repeating sequence's run, with the builders of the entries in it: each of its iterations plays them as its first one does,
 * and every other one of an oscillation flips them.
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

    build(): TrackGroup {
        const {name, timing, end, entries, holdsBefore, holdsAfter} = this;
        return {type: 'group', name, ...timing, end, entries: entries.map(entry => entry.build()), holdsBefore, holdsAfter};
    }

    protected withTiming(timing: TrackEntry): TrackGroupBuilder {
        return new TrackGroupBuilder(this.name, timing, this.entries);
    }

    /** When the last of its entries ends in its first iteration. */
    private get entriesEnd(): Seconds {
        return Math.max(...this.entries.map(entry => entry.end));
    }

    /** How long after an iteration starts its entries end in it, when it flips as `flip` says. */
    private entriesEndIn(flip: Oscillation | undefined): Seconds {
        const {start, iterationDuration} = this.timing;
        return flip ? start + iterationDuration - this.start : this.entriesEnd - start;
    }

    /** The topmost of its entries that start first. */
    private get firstEntry(): TrackEntryBuilder {
        return this.entries.reduce((first, entry) => entry.start <= first.start ? entry : first);
    }
}
