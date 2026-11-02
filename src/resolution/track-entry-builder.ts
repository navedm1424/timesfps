import type {CSSValue} from "../dom/mapping.ts";
import type {Easing} from "../easing.ts";
import type {RepeatOptions} from "../playback-options.ts";
import type {Seconds} from "../types.ts";
import {clamp} from "../utils/math.ts";
import {KeyedRamp, type TrackStops} from "./keyed-ramps.ts";
import type {Extrapolation, HoldExtrapolation, LoopExtrapolation, OscillateExtrapolation, TrackEntry} from "./track-entries.ts";
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

    /** `keyedRamp` is from the timing's start. */
    private constructor(
        private readonly name: string | undefined,
        private readonly timing: PlayTiming,
        private readonly keyedRamp: KeyedRamp<PendingValue>
    ) {}

    /** An entry's play through its stops, each missing value a placeholder of its own. */
    static play(name: string | undefined, timing: PlayTiming, easing: Easing, stops: TrackStops<CSSValue | null>): TrackEntryBuilder {
        return new TrackEntryBuilder(name, timing, KeyedRamp.play(timing.duration, easing, stops.map(value => value ?? placeholder())));
    }

    /** A repeating sequence's iteration, its children merged into it, `keyedRamp` after the outermost definition starts. */
    static merged(name: string | undefined, timing: PlayTiming, keyedRamp: KeyedRamp<PendingValue>): TrackEntryBuilder {
        return new TrackEntryBuilder(name, timing, keyedRamp.shifted(-timing.start));
    }

    /** When its first play starts. */
    get start(): Seconds {
        return this.timing.start + this.keyedRamp.start;
    }

    /** Whether it ends: it doesn't when it repeats forever. */
    get ends(): boolean {
        return !repeatsForever(this.timing);
    }

    /** When its last play ends; `Infinity` when it never ends. */
    get end(): Seconds {
        return this.ends ? this.playOf(this.lastPlayIndex).end : Infinity;
    }

    /** Its plays one after another; it must end. */
    get laidOut(): KeyedRamp<PendingValue> {
        this.requireEnd("plays to lay out one after another");
        return KeyedRamp.joined(Array.from({length: this.lastPlayIndex + 1}, (_, index) => this.playOf(index)));
    }

    /** Whether the value it starts on is missing. */
    get hasMissingStart(): boolean {
        return isMissing(this.startValue);
    }

    /** Whether the value it ends on is missing; one that never ends has none to take. */
    get hasMissingEnd(): boolean {
        return this.ends && isMissing(this.endValue);
    }

    /** The value its first play starts on. */
    get startValue(): PendingValue {
        return this.keyedRamp.startValue;
    }

    /** The value its last play ends on; it must end. */
    get endValue(): PendingValue {
        this.requireEnd("end value");
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
        assign(this.startValue, value);
    }

    /** Gives a missing end `value`; it must end. */
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

    /** The track entry: its play as its keyed ramp, each placeholder with its value, or the property's current value without one, and what it shows before and after it. */
    build(): TrackEntry {
        const {name, timing: {start, duration}, holdsBefore, holdsAfter} = this;
        const resolvedTokens = new Map<InterpolatedValueToken<PendingValue>, TrackValue>();
        const keyedRamp = this.keyedRamp.map(value => resolvedValueOf(value, resolvedTokens));
        const repeats = this.repeatPattern;
        const postExtrapolation: Extrapolation | undefined = repeats ? {...repeats, holdsAfter} : holdsAfter ? hold : undefined;
        return {name, start, duration, keyedRamp, ...(holdsBefore && {preExtrapolation: hold}), ...(postExtrapolation && {postExtrapolation})};
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

    /** Throws when it never ends, so it has no `missing`. */
    private requireEnd(missing: string): void {
        if (!this.ends)
            throw new Error(`A track entry builder that repeats forever never ends, so it has no ${missing}. Check \`ends\` first, or build it so it doesn't repeat forever.`);
    }

    /** Its play at `index`, from the timing's start. */
    private playOf(index: number): KeyedRamp<PendingValue> {
        const {start, duration, repeatOptions} = this.timing;
        return this.keyedRamp.iteration(index, duration, repeatOptions).shifted(start);
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

function isMissing(value: PendingValue): boolean {
    return openPlaceholderOf(value) !== undefined;
}

/**
 * Gives `value` to the placeholder without a value that `target` comes to, if there's one.
 * A value made from that placeholder can't be its own, so it stays without one.
 */
function assign(target: PendingValue, value: PendingValue): void {
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
