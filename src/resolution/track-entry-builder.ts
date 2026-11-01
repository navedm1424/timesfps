import type {CSSValue} from "../dom/mapping.ts";
import type {Easing} from "../easing.ts";
import type {RepeatOptions} from "../playback-options.ts";
import type {Seconds} from "../types.ts";
import {clamp} from "../utils/math.ts";
import {TrackRun, type TrackStops} from "./track-runs.ts";
import type {Extrapolation, HoldExtrapolation, LoopExtrapolation, OscillateExtrapolation, TrackEntry} from "./tracks.ts";
import {type CurrentValueToken, currentValueToken, type InterpolatedValueToken, type TrackValue} from "./track-values.ts";

/** When something starts, how long one play of it lasts, and how it repeats. */
export interface PlayTiming {
    /** After the outermost definition starts. */
    start: Seconds;
    duration: Seconds;
    repeatOptions: RepeatOptions;
}

/** A missing value, until a value is assigned to it: every span and token that has it then has that value. */
interface Placeholder {
    type: 'placeholder';
    value: PendingValue | undefined;
}

export type PendingValue = CSSValue | CurrentValueToken | Placeholder | InterpolatedValueToken<PendingValue>;

/** A repeat extrapolation before it knows whether it holds after. */
type RepeatPattern = Omit<LoopExtrapolation, 'holdsAfter'> | Omit<OscillateExtrapolation, 'holdsAfter'>;

const hold: HoldExtrapolation = {type: 'hold'};

/**
 * A track entry, built step by step: a play that repeats as its timing does, which is an entry's play, or a repeating sequence's iteration with its children merged into it.
 * Each missing value is a placeholder until a value is assigned to it. Then whether it holds before and after is set, and it builds into the track entry.
 */
export class TrackEntryBuilder {
    private holdsBefore = false;
    private holdsAfter = false;

    /** `play` is from the timing's start. */
    private constructor(
        private readonly name: string | undefined,
        private readonly timing: PlayTiming,
        private readonly play: TrackRun<PendingValue>
    ) {}

    /** An entry's play through its stops, each missing value a placeholder of its own. */
    static play(name: string | undefined, timing: PlayTiming, easing: Easing, stops: TrackStops<CSSValue | null>): TrackEntryBuilder {
        return new TrackEntryBuilder(name, timing, TrackRun.play(timing.duration, easing, stops.map(value => value ?? placeholder())));
    }

    /** A repeating sequence's iteration, its children merged into it, `iteration` after the outermost definition starts. */
    static merged(name: string | undefined, timing: PlayTiming, iteration: TrackRun<PendingValue>): TrackEntryBuilder {
        return new TrackEntryBuilder(name, timing, iteration.shifted(-timing.start));
    }

    /** When its first play starts. */
    get start(): Seconds {
        return this.timing.start + this.play.start;
    }

    /** When its last play ends; repeating forever, it never ends. */
    get end(): Seconds {
        return this.repeatsForever ? Infinity : this.playOf(this.lastPlayIndex).end;
    }

    /** Its plays one after another. */
    get laidOut(): TrackRun<PendingValue> {
        return TrackRun.joined(Array.from({length: this.lastPlayIndex + 1}, (_, index) => this.playOf(index)));
    }

    /** Whether the value it starts on is missing. */
    get hasOpenStart(): boolean {
        return isOpen(this.play.startValue);
    }

    /** Whether the value it ends on is missing; one that never ends has none to take. */
    get hasOpenEnd(): boolean {
        return !this.repeatsForever && isOpen(this.endValue);
    }

    /** The value its last play ends on. */
    get endValue(): PendingValue {
        return this.playOf(this.lastPlayIndex).endValue;
    }

    /** The value at `time`: its play's then, held in the pause after it, and the value it starts on before it, or ends on after it. */
    valueAt(time: Seconds): PendingValue {
        const {start, duration, repeatOptions: {repeatDelay = 0}} = this.timing;
        const index = duration === 0 ? 0 : clamp(Math.floor((time - start) / (duration + repeatDelay)), 0, this.lastPlayIndex);
        return this.playOf(index).valueAt(time);
    }

    /** Gives a missing start `value`. */
    assignStart(value: PendingValue): void {
        assign(this.play.startValue, value);
    }

    /** Gives a missing end `value`. */
    assignEnd(value: PendingValue): void {
        assign(this.endValue, value);
    }

    /** Makes it hold the value it starts on before it starts. */
    holdBefore(): void {
        this.holdsBefore = true;
    }

    /** Makes it hold the value it ends on after it ends. */
    holdAfter(): void {
        this.holdsAfter = true;
    }

    /** The track entry: its play as its keyed run, each placeholder with its value, or the property's current value without one, and what it shows before and after it. */
    build(): TrackEntry {
        const {name, timing: {start, duration}, holdsBefore, holdsAfter} = this;
        const resolvedTokens = new Map<InterpolatedValueToken<PendingValue>, TrackValue>();
        const keyedRun = this.play.map(value => resolvedValueOf(value, resolvedTokens));
        const repeats = this.repeatPattern;
        const postExtrapolation: Extrapolation | undefined = repeats ? {...repeats, holdsAfter} : holdsAfter ? hold : undefined;
        return {name, start, duration, keyedRun, ...(holdsBefore && {preExtrapolation: hold}), ...(postExtrapolation && {postExtrapolation})};
    }

    private get repeatsForever(): boolean {
        return repeatsForever(this.timing);
    }

    /** Its repeats after its first play: a loop, or an oscillation that flips in time for `reverse` and in values for `mirror`; none without repeats or duration. */
    private get repeatPattern(): RepeatPattern | undefined {
        const {duration, repeatOptions: {repeat = 0, repeatDelay = 0, repeatMode = 'loop'}} = this.timing;
        if (repeat === 0 || duration === 0) return undefined;
        const repeating = {iterations: repeat, pause: repeatDelay / duration};
        return repeatMode === 'loop'
            ? {type: 'loop', ...repeating}
            : {type: 'oscillate', ...repeating, flip: repeatMode === 'reverse' ? 'time' : 'values'};
    }

    /** The index of its last play: 0 without duration, and `Infinity` when it repeats forever. */
    private get lastPlayIndex(): number {
        const {duration, repeatOptions: {repeat = 0}} = this.timing;
        return duration === 0 ? 0 : repeat;
    }

    /** Its play at `index`, from the timing's start. */
    private playOf(index: number): TrackRun<PendingValue> {
        const {start, duration, repeatOptions} = this.timing;
        return this.play.iteration(index, duration, repeatOptions).shifted(start);
    }
}

/**
 * Track entry builders laid over each other in the order they're added, each over the ones before it.
 * - One that a later one starts with or before, and ends with or after, never shows.
 * - A missing start or end takes the value of the topmost one under it running there, other than the ones it hides.
 *   With none, a start takes the end value of the closest one that ends by it, and an end the start of the closest one that starts once it ends,
 *   the topmost of ties, and when both values are missing, or there's none, they're the current value.
 * - It holds after it ends when it ends, and its end lands on none under it. The last added of the ones that start first holds before it starts.
 */
export class TrackLayering {
    /** In the order they're added; one that never shows is null. */
    private readonly runs: (TrackEntryBuilder | null)[] = [];
    /** Each one whose missing start lands on none, and the closest one that ends by its start. */
    private readonly startNeighbors = new Map<TrackEntryBuilder, TrackEntryBuilder | undefined>();
    /** Each one whose missing end lands on none, and the closest one that starts once it ends. */
    private readonly endNeighbors = new Map<TrackEntryBuilder, TrackEntryBuilder | undefined>();
    /** The last added of the ones that start first. */
    private firstStarting: TrackEntryBuilder | undefined;

    add(run: TrackEntryBuilder): void {
        let startLanding: TrackEntryBuilder | undefined;
        let endLanding: TrackEntryBuilder | undefined;
        let startNeighbor: TrackEntryBuilder | undefined;
        let endNeighbor: TrackEntryBuilder | undefined;
        for (let index = this.runs.length - 1; index >= 0; index--) {
            const below = this.runs[index];
            if (!below)
                continue;
            if (run.start <= below.start && below.end <= run.end) {
                this.runs[index] = null;
                continue;
            }
            if (!startLanding && below.start <= run.start && run.start < below.end)
                startLanding = below;
            if (!endLanding && below.start <= run.end && run.end < below.end)
                endLanding = below;
            if (below.end <= run.start && (!startNeighbor || below.end > startNeighbor.end))
                startNeighbor = below;
            if (below.start >= run.end && (!endNeighbor || below.start < endNeighbor.start))
                endNeighbor = below;
        }

        for (const [waiting, neighbor] of this.startNeighbors) {
            if (run.end <= waiting.start && (!neighbor || run.end >= neighbor.end))
                this.startNeighbors.set(waiting, run);
        }
        for (const [waiting, neighbor] of this.endNeighbors) {
            if (run.start >= waiting.end && (!neighbor || run.start <= neighbor.start))
                this.endNeighbors.set(waiting, run);
        }

        if (startLanding)
            run.assignStart(startLanding.valueAt(run.start));
        else if (run.hasOpenStart)
            this.startNeighbors.set(run, startNeighbor);
        if (endLanding)
            run.assignEnd(endLanding.valueAt(run.end));
        else {
            if (run.end !== Infinity)
                run.holdAfter();
            if (run.hasOpenEnd)
                this.endNeighbors.set(run, endNeighbor);
        }
        if (!this.firstStarting || run.start <= this.firstStarting.start)
            this.firstStarting = run;
        this.runs.push(run);
    }

    /** The track entries of the ones that show, in the order they're added, each missing value that waited for a neighbor taking its value. */
    build(): TrackEntry[] {
        for (const [run, neighbor] of this.startNeighbors)
            run.assignStart(neighbor?.endValue ?? currentValueToken);
        for (const [run, neighbor] of this.endNeighbors)
            run.assignEnd(neighbor?.valueAt(neighbor.start) ?? currentValueToken);
        this.firstStarting?.holdBefore();
        return this.runs.filter(run => run !== null).map(run => run.build());
    }
}

/** Whether it has duration and repeats forever. */
export function repeatsForever({duration, repeatOptions}: PlayTiming): boolean {
    return duration > 0 && repeatOptions.repeat === Infinity;
}

function placeholder(): Placeholder {
    return {type: 'placeholder', value: undefined};
}

function isPlaceholder(value: PendingValue): value is Placeholder {
    return typeof value === 'object' && value.type === 'placeholder';
}

/** The placeholder without a value that `value` comes to, through the placeholders it has. */
function openPlaceholderOf(value: PendingValue): Placeholder | undefined {
    if (!isPlaceholder(value)) return undefined;
    return value.value === undefined ? value : openPlaceholderOf(value.value);
}

export function isOpen(value: PendingValue): boolean {
    return openPlaceholderOf(value) !== undefined;
}

/**
 * Gives `value` to the placeholder without a value that `target` comes to, if there's one.
 * A value made from that placeholder can't be its own, so it stays without one.
 */
export function assign(target: PendingValue, value: PendingValue): void {
    const open = openPlaceholderOf(target);
    if (open && !isMadeFrom(value, open)) open.value = value;
}

/** Whether `value` is the placeholder, or comes to it through placeholders and the ends of interpolated values. */
function isMadeFrom(value: PendingValue, placeholder: Placeholder): boolean {
    if (value === placeholder) return true;
    if (typeof value !== 'object' || value.type === 'currentValue') return false;
    if (value.type === 'placeholder') return value.value !== undefined && isMadeFrom(value.value, placeholder);
    return isMadeFrom(value.start, placeholder) || isMadeFrom(value.end, placeholder);
}

/** The value with each placeholder's value, and the property's current value for each one without; an interpolated value resolves once. */
function resolvedValueOf(value: PendingValue, resolvedTokens: Map<InterpolatedValueToken<PendingValue>, TrackValue>): TrackValue {
    if (isPlaceholder(value)) return value.value === undefined ? currentValueToken : resolvedValueOf(value.value, resolvedTokens);
    if (typeof value !== 'object' || value.type === 'currentValue') return value;

    let resolved = resolvedTokens.get(value);
    if (!resolved) resolvedTokens.set(value, resolved = {...value, start: resolvedValueOf(value.start, resolvedTokens), end: resolvedValueOf(value.end, resolvedTokens)});
    return resolved;
}
