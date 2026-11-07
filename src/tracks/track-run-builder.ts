import type {CSSValue} from "../dom/mapping.ts";
import type {Easing} from "../easing.ts";
import type {TweenStops} from "../tween-stops.ts";
import type {Progress, Seconds} from "../types.ts";
import {getOrInsertComputed} from "../utils/collections.ts";
import {clamp} from "../utils/math.ts";
import {iterationSpansOf, joinedSpans, repeatsForever, TrackRun, TrackRunSpan, type TrackRunTiming, type TrackStop} from "./track-runs.ts";
import {type CurrentValueToken, currentValueToken, type InterpolatedValueToken, type TrackValue} from "./track-values.ts";

/** A missing value, until a value is assigned to it: every span and token that has it then has that value. */
interface Placeholder {
    type: 'placeholder';
    value: PendingValue | undefined;
}

export type PendingValue = CSSValue | CurrentValueToken | Placeholder | InterpolatedValueToken<PendingValue>;

/**
 * A track run, built step by step: an entry's iteration, or a repeating sequence's iteration with its children merged into it, that repeats as its timing does.
 * Each missing value is a placeholder until a value is assigned to it. Then whether it holds before and after is set, and it builds into the track run.
 */
export class TrackRunBuilder {
    private holdsBefore = false;
    private holdsAfter = false;

    /** `spans` are its iteration, one after another without gaps, from the timing's start. */
    private constructor(
        private readonly name: string | undefined,
        private readonly timing: TrackRunTiming,
        private readonly spans: readonly TrackRunSpan<PendingValue>[]
    ) {}

    /** An entry's iteration through its stops, each missing value a placeholder of its own. */
    static fromStops(name: string | undefined, timing: TrackRunTiming, easing: Easing, stops: TweenStops): TrackRunBuilder {
        const spanStops = stops.stops.map(({offset, value}) => ({offset, value: value ?? placeholder()}));
        return new TrackRunBuilder(name, timing, [new TrackRunSpan(0, timing.duration, easing, spanStops)]);
    }

    /**
     * A repeating sequence's iteration, the iterations of `children` merged into it in stacking order, each over the ones before it.
     * One that starts within the ones before it replaces them while it lasts; one that starts where they end, or later, follows them, their end value held until then.
     * Throws without children; each one must end.
     */
    static merged(name: string | undefined, timing: TrackRunTiming, children: readonly TrackRunBuilder[]): TrackRunBuilder {
        if (!children.length)
            throw new Error("A repeating sequence's iteration merges the iterations of the runs in it, but it was given none. Merge at least one.");
        const [first, ...rest] = children.map(child => {
            child.requireEnd("iterations to merge");
            return child.iterationSpans(0, child.lastIterationIndex);
        });
        const spans = rest.reduce<TrackRunSpan<PendingValue>[]>((below, top) => overlaidSpans(below, top), first!);
        return new TrackRunBuilder(name, timing, spans.map(span => span.shifted(-timing.start)));
    }

    /** When its first iteration starts. */
    get start(): Seconds {
        return this.timing.start + this.spans[0]!.start;
    }

    /** Whether it ends: it doesn't when it repeats forever. */
    get ends(): boolean {
        return !repeatsForever(this.timing);
    }

    /** When its last iteration ends; `Infinity` when it never ends. */
    get end(): Seconds {
        return this.ends ? this.iterationAt(this.lastIterationIndex).at(-1)!.end : Infinity;
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
        return this.spans[0]!.startValue;
    }

    /** The value its last iteration ends on; it must end. */
    get endValue(): PendingValue {
        this.requireEnd("end value");
        return this.iterationAt(this.lastIterationIndex).at(-1)!.endValue;
    }

    /** The value at `time`: its iteration's then, held through the repeat delay after it, and the value it starts on before it, or ends on after it. */
    valueAt(time: Seconds): PendingValue {
        const {start, duration, repeatDelay} = this.timing;
        const index = this.lastIterationIndex === 0 ? 0 : clamp(Math.floor((time - start) / (duration + repeatDelay)), 0, this.lastIterationIndex);
        return valueAtTimeOf(this.iterationAt(index), time);
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

    /** The track run: each placeholder with its value, or the property's current value without one, and whether it holds before and after it. */
    build(): TrackRun<TrackValue> {
        const resolvedTokens = new Map<InterpolatedValueToken<PendingValue>, TrackValue>();
        const spans = this.spans.map(span => span.map(value => resolvedValueOf(value, resolvedTokens)));
        return new TrackRun(this.name, this.timing, spans, this.holdsBefore, this.holdsAfter);
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

    /** Its iterations from `first` to `last`, one after another, after the outermost definition starts. */
    private iterationSpans(first: number, last: number): TrackRunSpan<PendingValue>[] {
        return iterationSpansOf(this.timing, this.spans, first, last);
    }

    /** Its iteration at `index`, after the outermost definition starts. */
    private iterationAt(index: number): TrackRunSpan<PendingValue>[] {
        return this.iterationSpans(index, index);
    }
}

/** The value at `time` of spans one after another, which is the next span's start where two meet. */
function valueAtTimeOf(spans: readonly TrackRunSpan<PendingValue>[], time: Seconds): PendingValue {
    const span = spans.findLast(span => span.start <= time) ?? spans[0]!;
    return span.valueAtProgress(progressAt(span, time));
}

/** The span's progress at `time`: where its easing starts before it, and where it ends after it. */
function progressAt({start, end, easing}: TrackRunSpan<unknown>, time: Seconds): Progress {
    if (time >= end) return easing.endProgress;
    if (time <= start) return easing.startProgress;
    return easing.progressAt((time - start) / (end - start));
}

/**
 * The spans with `top`'s in place of their own for as long as `top` lasts,
 * or, when `top` starts where they end or later, followed by `top`'s, their end value held until then.
 */
function overlaidSpans(below: readonly TrackRunSpan<PendingValue>[], top: readonly TrackRunSpan<PendingValue>[]): TrackRunSpan<PendingValue>[] {
    const start = below[0]!.start;
    const end = below.at(-1)!.end;
    const topStart = top[0]!.start;
    if (topStart >= end) return joinedSpans([below, top]);
    return [...cutSpans(below, start, topStart), ...top, ...cutSpans(below, top.at(-1)!.end, end)];
}

/**
 * The part of the spans from `start` to `end`. A span cut through its easing keeps the stops its cut easing reaches, where they are,
 * with a stop at each progress the cut easing starts, turns and ends at that has none: the value there.
 * A span without duration stays from `start` up to, but not at, `end`.
 */
function cutSpans(spans: readonly TrackRunSpan<PendingValue>[], start: Seconds, end: Seconds): TrackRunSpan<PendingValue>[] {
    return spans.flatMap((span): TrackRunSpan<PendingValue>[] => {
        if (span.end === span.start) return span.start >= start && span.start < end ? [span] : [];
        const cutStart = Math.max(span.start, start);
        const cutEnd = Math.min(span.end, end);
        if (cutEnd <= cutStart) return [];
        if (cutStart === span.start && cutEnd === span.end) return [span];

        const offsetOf = (time: Seconds) => (time - span.start) / (span.end - span.start);
        const easing = span.easing.segment(offsetOf(cutStart), offsetOf(cutEnd));
        return [new TrackRunSpan(cutStart, cutEnd, easing, narrowedStopsOf(span, reachedProgressesOf(easing)))];
    });
}

/** The span's stops between the lowest and the highest of the progresses, with a stop of the value there at each of the progresses that has none; offsets stay as they are. */
function narrowedStopsOf(span: TrackRunSpan<PendingValue>, progresses: readonly Progress[]): TrackStop<PendingValue>[] {
    const reached = span.stopsBetween(Math.min(...progresses), Math.max(...progresses)).map(({offset}) => offset);
    const offsets = [...new Set([...reached, ...progresses])].sort((first, second) => first - second);
    return offsets.map(offset => ({offset, value: span.valueAtProgress(offset)}));
}

/** The progresses the easing's window starts at, turns at and ends at. */
function reachedProgressesOf(easing: Easing): Progress[] {
    return [easing.startProgress, ...easing.turningOffsets().map(offset => easing.progressAt(offset)), easing.endProgress];
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
