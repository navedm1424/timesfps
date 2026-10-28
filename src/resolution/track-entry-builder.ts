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

type PendingValue = CSSValue | CurrentValueToken | Placeholder | InterpolatedValueToken<PendingValue>;

/** A repeat extrapolation before it knows whether it holds after. */
type RepeatPattern = Omit<LoopExtrapolation, 'holdsAfter'> | Omit<OscillateExtrapolation, 'holdsAfter'>;

const hold: HoldExtrapolation = {type: 'hold'};

/**
 * A track entry, built step by step: a play that repeats as its timing does, which is an entry's play, or a repeating sequence's iteration with its children merged into it.
 * Each missing value is a placeholder until a value is assigned to it. Then whether it's hidden, and whether it holds before and after, are set, and it builds into the track entry.
 */
export class TrackEntryBuilder {
    /** The builders in it that repeat forever, which continue on their own under it once it's done; none when it repeats forever too. */
    private readonly copies: readonly TrackEntryBuilder[];
    private hidden = false;
    private holdsBefore = false;
    private holdsAfter = false;

    /** `play` is from the timing's start. */
    private constructor(
        private readonly name: string | undefined,
        private readonly timing: PlayTiming,
        private readonly play: TrackRun<PendingValue>,
        children: readonly TrackEntryBuilder[] = []
    ) {
        this.copies = this.repeatsForever ? [] : children.flatMap(child => child.repeatsForever ? [child] : child.copies);
    }

    /** An entry's play through its stops, each missing value a placeholder of its own. */
    static play(name: string | undefined, timing: PlayTiming, easing: Easing, stops: TrackStops<CSSValue | null>): TrackEntryBuilder {
        return new TrackEntryBuilder(name, timing, TrackRun.play(timing.duration, easing, stops.map(value => value ?? placeholder())));
    }

    /**
     * A repeating sequence's iteration with its children's plays laid out in it, in stacking order, each over the ones before it.
     * A child that starts within the ones before it takes a missing start from them there.
     * One that starts where they end, or later, follows them, their end value held until then: its missing start takes their end value,
     * or, when theirs is missing too, both are the current value.
     * A missing end takes the value of the ones before it there when it ends within them; otherwise, the start of the next child that starts after it.
     */
    static merged(name: string | undefined, timing: PlayTiming, children: readonly TrackEntryBuilder[]): TrackEntryBuilder {
        const [first, ...rest] = children.map(child => child.laidOutUntil(timing.start + timing.duration));
        let iteration = first!;
        /** The children whose missing end waits for a start, in the order they end. */
        const pending = isOpen(iteration.endValue) ? [iteration] : [];
        for (const top of rest) {
            const follows = top.start >= iteration.end;
            if (follows && isOpen(top.startValue) && isOpen(iteration.endValue)) {
                assign(top.startValue, currentValueToken);
                assign(iteration.endValue, currentValueToken);
            } else
                assign(top.startValue, iteration.valueAt(top.start));
            while (pending[0] && pending[0].end <= top.start) assign(pending.shift()!.endValue, top.startValue);

            if (top.end < iteration.end) assign(top.endValue, iteration.valueAt(top.end));
            else if (isOpen(top.endValue)) pending.push(top);
            iteration = follows ? TrackRun.joined([iteration, top]) : iteration.overlaid(top);
        }
        return new TrackEntryBuilder(name, timing, iteration.shifted(-timing.start), children);
    }

    /** When its first play starts. */
    get start(): Seconds {
        return this.timing.start + this.play.start;
    }

    /** When its last play ends; repeating forever, it never ends. */
    get end(): Seconds {
        return this.repeatsForever ? Infinity : this.playOf(this.lastPlayIndex).end;
    }

    /** Its copies, then itself over them. */
    get layers(): TrackEntryBuilder[] {
        return [...this.copies, this];
    }

    /** Whether the value it starts on is missing. */
    get hasOpenStart(): boolean {
        return isOpen(this.play.startValue);
    }

    /** Whether the value it ends on is missing; one that never ends has none to take. */
    get hasOpenEnd(): boolean {
        return !this.repeatsForever && isOpen(this.endValue);
    }

    /** Gives a missing start the value `other` has there. */
    assignStartInterpolation(other: TrackEntryBuilder): void {
        assign(this.play.startValue, other.valueAt(this.start));
    }

    /** Gives a missing end the value `other` has there. */
    assignEndInterpolation(other: TrackEntryBuilder): void {
        assign(this.endValue, other.valueAt(this.end));
    }

    /** Gives a missing start the property's current value. */
    assignStartCurrentValue(): void {
        assign(this.play.startValue, currentValueToken);
    }

    /** Gives a missing end the property's current value. */
    assignEndCurrentValue(): void {
        assign(this.endValue, currentValueToken);
    }

    /** Leaves it out of the track: it never shows. */
    hide(): void {
        this.hidden = true;
    }

    /** Makes it hold the value it starts on before it starts. */
    holdBefore(): void {
        this.holdsBefore = true;
    }

    /** Makes it hold the value it ends on after it ends. */
    holdAfter(): void {
        this.holdsAfter = true;
    }

    /** The track entry, none when it's hidden: its play as its keyed run, each placeholder with its value, or the property's current value without one, and what it shows before and after it. */
    build(): TrackEntry | undefined {
        if (this.hidden) return undefined;
        const {name, timing: {start, duration}, holdsBefore, holdsAfter} = this;
        const resolvedTokens = new Map<InterpolatedValueToken<PendingValue>, TrackValue>();
        const keyedRun = this.play.map(value => resolvedValueOf(value, resolvedTokens));
        const repeats = this.repeatPattern;
        const postExtrapolation: Extrapolation | undefined = repeats ? {...repeats, holdsAfter} : holdsAfter ? hold : undefined;
        return {name, start, duration, keyedRun, ...(holdsBefore && {preExtrapolation: hold}), ...(postExtrapolation && {postExtrapolation})};
    }

    /** Whether it has duration and repeats forever. */
    private get repeatsForever(): boolean {
        const {duration, repeatOptions} = this.timing;
        return duration > 0 && repeatOptions.repeat === Infinity;
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

    /** The value its last play ends on. */
    private get endValue(): PendingValue {
        return this.playOf(this.lastPlayIndex).endValue;
    }

    /** The index of its last play: 0 without duration, and `Infinity` when it repeats forever. */
    private get lastPlayIndex(): number {
        const {duration, repeatOptions: {repeat = 0}} = this.timing;
        return duration === 0 ? 0 : repeat;
    }

    /** The value at `time`: its play's then, held in the pause after it, and the value it starts on before it, or ends on after it. */
    private valueAt(time: Seconds): PendingValue {
        const {start, duration, repeatOptions: {repeatDelay = 0}} = this.timing;
        const index = duration === 0 ? 0 : clamp(Math.floor((time - start) / (duration + repeatDelay)), 0, this.lastPlayIndex);
        return this.playOf(index).valueAt(time);
    }

    /** Its play at `index`, from the timing's start. */
    private playOf(index: number): TrackRun<PendingValue> {
        const {start, duration, repeatOptions} = this.timing;
        return this.play.iteration(index, duration, repeatOptions).shifted(start);
    }

    /** Its plays one after another; repeating forever, up to `until`. */
    private laidOutUntil(until: Seconds): TrackRun<PendingValue> {
        const {start, duration, repeatOptions: {repeatDelay = 0}} = this.timing;
        const playCount = this.repeatsForever ? Math.ceil((until - start) / (duration + repeatDelay)) : this.lastPlayIndex + 1;
        const run = TrackRun.joined(Array.from({length: playCount}, (_, index) => this.playOf(index)));
        return this.repeatsForever ? run.cut(run.start, until) : run;
    }
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

function isOpen(value: PendingValue): boolean {
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
