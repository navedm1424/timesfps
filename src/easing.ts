import {CubicBezier} from "./cubic-bezier.ts";
import type {DampedSpring} from "./damped-spring.ts";
import type {Progress, Seconds} from "./types.ts";
import {clamp, invLerp, lerp, solveMonotone} from "./utils/math.ts";
import {checkNumber} from "./utils/validation.ts";

export type CubicBezierEasingParams = readonly [x1: number, y1: number, x2: number, y2: number];
export type StepPosition = 'jumpStart' | 'jumpEnd' | 'jumpNone' | 'jumpBoth';
export type StepsEasingParams = readonly [count: number, position?: StepPosition];

/** How far outside the window an offset found by solving may land and still count as inside it. */
const offsetTolerance = 1e-9;

/**
 * An easing's progress over its input time, 0–1, within a window of it, which runs backwards when its end comes before its start.
 * Offsets are fractions of the window, and the progress isn't rescaled to it.
 */
export abstract class Easing {
    constructor(readonly windowStart: number = 0, readonly windowEnd: number = 1) {}

    protected abstract progressAtInput(input: number): Progress;
    /** The inputs strictly between 0 and 1 at which the progress turns back. */
    protected abstract turningInputs(): number[];
    /** The inputs at which the progress reaches `progress`. */
    protected abstract inputsAt(progress: Progress): number[];
    protected abstract withWindow(windowStart: number, windowEnd: number): Easing;

    /** Whether the window is the whole easing, forwards. */
    get isWhole(): boolean {
        return this.windowStart === 0 && this.windowEnd === 1;
    }

    progressAt(offset: number): Progress {
        return this.progressAtInput(lerp(this.windowStart, this.windowEnd, offset));
    }

    /** The progress the window starts from, before any jump right at its start. */
    get startProgress(): Progress {
        return this.progressAt(0);
    }

    /** The progress the window ends at, after any jump right at its end. */
    get endProgress(): Progress {
        return this.progressAt(1);
    }

    /** The offsets inside the window at which the progress turns back, in order. */
    turningOffsets(): number[] {
        return this.offsetsOf(this.turningInputs()).filter(offset => offset > offsetTolerance && offset < 1 - offsetTolerance);
    }

    /** The offsets in the window at which the progress reaches `progress`, in order. */
    offsetsAt(progress: Progress): number[] {
        return this.offsetsOf(this.inputsAt(progress))
            .filter(offset => offset >= -offsetTolerance && offset <= 1 + offsetTolerance)
            .map(offset => clamp(offset, 0, 1));
    }

    /** A new easing of the part of the window between the two offsets, which runs backwards when `endOffset` comes first. */
    segment(startOffset: number, endOffset: number): this {
        return this.withWindow(lerp(this.windowStart, this.windowEnd, startOffset), lerp(this.windowStart, this.windowEnd, endOffset)) as this;
    }

    /** A new easing of the window run backwards. */
    reverse(): this {
        return this.withWindow(this.windowEnd, this.windowStart) as this;
    }

    protected offsetsOf(inputs: readonly number[]): number[] {
        return inputs.map(input => invLerp(this.windowStart, this.windowEnd, input)).sort((first, second) => first - second);
    }
}

export class LinearEasing extends Easing {
    protected progressAtInput(input: number): Progress {
        return input;
    }

    protected turningInputs(): number[] {
        return [];
    }

    protected inputsAt(progress: Progress): number[] {
        return [progress];
    }

    protected withWindow(windowStart: number, windowEnd: number): LinearEasing {
        return new LinearEasing(windowStart, windowEnd);
    }
}

/** A CSS `cubic-bezier()`: a curve from (0, 0) to (1, 1) whose time, x, never turns back. */
export class CubicBezierEasing extends Easing {
    readonly curve: CubicBezier;

    constructor(readonly params: CubicBezierEasingParams, windowStart?: number, windowEnd?: number) {
        super(windowStart, windowEnd);
        CubicBezierEasing.check(params, "A cubic Bézier easing");
        const [x1, y1, x2, y2] = params;
        this.curve = new CubicBezier({x: 0, y: 0}, {x: x1, y: y1}, {x: x2, y: y2}, {x: 1, y: 1});
    }

    /** Every control point must be finite, with `x1` and `x2` within 0–1; `label` names the easing in messages. */
    static check(params: CubicBezierEasingParams, label: string): void {
        const [x1, y1, x2, y2] = params;
        checkNumber(x1, `${label}'s x1`);
        checkNumber(y1, `${label}'s y1`);
        checkNumber(x2, `${label}'s x2`);
        checkNumber(y2, `${label}'s y2`);
        if (!(x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1))
            throw new RangeError(`${label}'s x control points must be within 0–1, not ${x1} and ${x2}.`);
    }

    static of(x1: number, y1: number, x2: number, y2: number): CubicBezierEasing {
        return new CubicBezierEasing([x1, y1, x2, y2]);
    }

    protected progressAtInput(input: number): Progress {
        return this.curve.coordinateAt('y', this.curve.parameterAt('x', input));
    }

    protected turningInputs(): number[] {
        return this.curve.turningParameters('y').map(t => this.curve.coordinateAt('x', t));
    }

    protected inputsAt(progress: Progress): number[] {
        return this.curve.parametersAt('y', progress).map(t => this.curve.coordinateAt('x', t));
    }

    protected withWindow(windowStart: number, windowEnd: number): CubicBezierEasing {
        return new CubicBezierEasing(this.params, windowStart, windowEnd);
    }
}

const stepPositions: readonly StepPosition[] = ['jumpStart', 'jumpEnd', 'jumpNone', 'jumpBoth'];

/** A CSS `steps()`: the output only ever rises, in jumps. */
export class StepsEasing extends Easing {
    constructor(readonly params: StepsEasingParams, windowStart?: number, windowEnd?: number) {
        super(windowStart, windowEnd);
        StepsEasing.check(params, "A steps easing");
    }

    /** The position must be one CSS has, and the count whole and at least 1, or 2 for `jumpNone`; `label` names the easing in messages. */
    static check(params: StepsEasingParams, label: string): void {
        const [count, position = 'jumpEnd'] = params;
        if (!stepPositions.includes(position))
            throw new TypeError(`${label} jumps as "${position}", which isn't one of ${stepPositions.map(stepPosition => `"${stepPosition}"`).join(', ')}.`);
        const leastCount = position === 'jumpNone' ? 2 : 1;
        if (!(Number.isInteger(count) && count >= leastCount))
            throw new RangeError(`${label} jumping as "${position}" needs a whole count of at least ${leastCount}, not ${count}.`);
    }

    /** How many times the output jumps over the whole easing, counting the jumps at its ends. */
    private get jumpCount(): number {
        const [count, position = 'jumpEnd'] = this.params;
        return {jumpStart: count, jumpEnd: count, jumpNone: count - 1, jumpBoth: count + 1}[position];
    }

    /** 1 when the output jumps as the input starts, 0 otherwise. */
    private get startJump(): number {
        const [, position = 'jumpEnd'] = this.params;
        return position === 'jumpStart' || position === 'jumpBoth' ? 1 : 0;
    }

    protected progressAtInput(input: number): Progress {
        const [count] = this.params;
        const step = Math.floor(input * count) + this.startJump;
        return clamp(step, 0, this.jumpCount) / this.jumpCount;
    }

    /** The output just before the input, where a jump at the input hasn't happened yet. */
    private progressBeforeInput(input: number): Progress {
        const [count] = this.params;
        const step = Math.ceil(input * count - offsetTolerance) - 1 + this.startJump;
        return clamp(step, 0, this.jumpCount) / this.jumpCount;
    }

    /** The output is right-continuous, so the edge the window enters from may need the output before a jump there. */
    override get startProgress(): Progress {
        return this.windowStart <= this.windowEnd ? this.progressBeforeInput(this.windowStart) : this.progressAtInput(this.windowStart);
    }

    override get endProgress(): Progress {
        return this.windowStart <= this.windowEnd ? this.progressAtInput(this.windowEnd) : this.progressBeforeInput(this.windowEnd);
    }

    protected turningInputs(): number[] {
        return [];
    }

    /** The input at which the output first reaches the progress. */
    protected inputsAt(progress: Progress): number[] {
        if (!(progress <= 1)) return [];
        const [count] = this.params;
        const step = Math.ceil(progress * this.jumpCount - offsetTolerance) - this.startJump;
        return [clamp(step, 0, count) / count];
    }

    /** The offsets strictly inside the window at which the output jumps, in order. */
    jumpOffsets(): number[] {
        const [count] = this.params;
        const inputs = Array.from({length: count - 1}, (_, index) => (index + 1) / count);
        return this.offsetsOf(inputs).filter(offset => offset > offsetTolerance && offset < 1 - offsetTolerance);
    }

    protected withWindow(windowStart: number, windowEnd: number): StepsEasing {
        return new StepsEasing(this.params, windowStart, windowEnd);
    }
}

/** A spring's motion over `duration`, with the gap it leaves there closed evenly after its last turning point, so it ends at 1. */
export class SpringEasing extends Easing {
    /** The times at which the spring turns back, in order. */
    readonly turningTimes: readonly Seconds[];
    private readonly closingStart: Seconds;
    private readonly closingGap: Progress;

    constructor(readonly spring: DampedSpring, readonly duration: Seconds, windowStart?: number, windowEnd?: number) {
        super(windowStart, windowEnd);
        this.turningTimes = spring.turningTimes(duration);
        this.closingStart = this.turningTimes.at(-1) ?? 0;
        this.closingGap = 1 - spring.positionAt(duration);
    }

    progressAtTime(time: Seconds): Progress {
        return this.spring.positionAt(time) + this.closingGap * Math.max(0, invLerp(this.closingStart, this.duration, time));
    }

    /** The progress per second. */
    slopeAtTime(time: Seconds): number {
        const closingSlope = time > this.closingStart ? this.closingGap / (this.duration - this.closingStart) : 0;
        return this.spring.velocityAt(time) + closingSlope;
    }

    protected progressAtInput(input: number): Progress {
        return this.progressAtTime(input * this.duration);
    }

    protected turningInputs(): number[] {
        return this.turningTimes.map(time => time / this.duration);
    }

    /** Searches each stretch between turning times, where the progress only rises or only falls. */
    protected inputsAt(progress: Progress): number[] {
        const boundaries = [0, ...this.turningTimes, this.duration];
        return boundaries.slice(1).flatMap((high, index) => {
            const low = boundaries[index]!;
            const lowProgress = this.progressAtTime(low);
            const highProgress = this.progressAtTime(high);
            const reachedAtLow = index > 0 && progress === lowProgress;
            const reached = Math.min(lowProgress, highProgress) <= progress && progress <= Math.max(lowProgress, highProgress);
            if (!reached || reachedAtLow) return [];
            const time = solveMonotone(time => this.progressAtTime(time), time => this.slopeAtTime(time), progress, low, high);
            return [time / this.duration];
        });
    }

    protected withWindow(windowStart: number, windowEnd: number): SpringEasing {
        return new SpringEasing(this.spring, this.duration, windowStart, windowEnd);
    }
}
