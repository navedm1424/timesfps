import type {Seconds} from "../types.ts";
import {easingAndKeyframesOf, type NativeKeyframe} from "./keyframes.ts";
import type {NativeEasing} from "./native-easing.ts";
import type {ResolvedTrackGroup, ResolvedTrackItem} from "./resolved-track-entries.ts";

/** One WAAPI effect on one property. */
export interface NativeEffect {
    delay: Seconds;
    duration: Seconds;
    iterations: number;
    direction: PlaybackDirection;
    fill: FillMode;
    easing: NativeEasing;
    keyframes: NativeKeyframe[];
    /** Its track entry's, which an animation on its own doesn't have. */
    name: string | undefined;
}

/** A stretch of time, and the plays in it, one after another without gaps. */
interface Stretch {
    /** After the outermost definition starts. */
    start: Seconds;
    duration: Seconds;
    plays: readonly ResolvedTrackItem[];
}

/** Builds a resolved track entry into the effects WAAPI plays it as. */
export class NativeEffectBuilder {
    constructor(private readonly entry: ResolvedTrackItem | ResolvedTrackGroup) {}

    /**
     * Its effects: its repeats as WAAPI iterations where WAAPI can repeat them, and laid out in keyframes where it can't.
     * The first effect holds before it when it does, and every effect holds after it when it does.
     */
    build(): NativeEffect[] {
        const {start, iterationDuration, repeatCount, repeatDelay, oscillate, holdsBefore, holdsAfter, name, ends} = this.entry;
        const playCount = repeatCount + 1;
        const effect = (
            first: number,
            last: number,
            {iterations = 1, direction = 'normal', holdsUntilNext = false}: { iterations?: number; direction?: PlaybackDirection; holdsUntilNext?: boolean } = {}
        ): NativeEffect => {
            const stretch = this.stretch(first, last, {holdsUntilNext});
            const fill = fillOf(first === 0 && holdsBefore, holdsAfter);
            return {delay: stretch.start, duration: stretch.duration, iterations, direction, fill, name, ...easingAndKeyframesOf(stretch.plays, stretch.start, stretch.duration)};
        };

        // iteration
        if (repeatCount === 0)
            return [effect(0, 0)];

        // iteration × playCount, alternating when it oscillates in time
        const iteration = this.entry.plays(0, 0);
        const fillsIteration = iteration[0]!.start === start && iteration.at(-1)!.end === start + iterationDuration;
        if (oscillate !== 'values' && repeatDelay === 0 && fillsIteration)
            return [effect(0, 0, {iterations: playCount, direction: oscillate === 'time' ? 'alternate' : 'normal'})];

        // [iteration+hold] × repeatCount, then the last iteration on its own; [iteration+hold] × ∞ when repeating forever
        if (!oscillate) {
            const repeating = effect(0, 0, {iterations: repeatCount, holdsUntilNext: true});
            return ends ? [repeating, effect(repeatCount, repeatCount)] : [repeating];
        }

        const repeatingPairs = (iterations: number) => effect(0, 1, {iterations, holdsUntilNext: true});

        // [iteration+hold, flipped+hold] × ∞
        if (!ends)
            return [repeatingPairs(Infinity)];

        // [iteration+hold, flipped+hold] × repeatCount/2, then the last iteration on its own
        if (playCount % 2 === 1)
            return [repeatingPairs(repeatCount / 2), effect(repeatCount, repeatCount)];

        // [iteration+hold, flipped] on its own
        if (playCount === 2)
            return [effect(0, 1)];

        // [iteration+hold, flipped+hold] × (repeatCount−1)/2, then [iteration+hold, flipped] on its own
        return [repeatingPairs((repeatCount - 1) / 2), effect(repeatCount - 1, repeatCount)];
    }

    /**
     * Its iterations from `first` to `last`, one after another, each one's end value held until the next starts, as a stretch from where the first one's
     * plays start to where the last one's end; with `holdsUntilNext`, the last one's end value is held too, until the iteration after it would start.
     * Throws for iterations it doesn't have.
     */
    private stretch(first: number, last: number, {holdsUntilNext = false}: { holdsUntilNext?: boolean } = {}): Stretch {
        const {repeatCount} = this.entry;
        if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || first > last || last > repeatCount)
            throw new Error(`A native effect builder's iterations are 0 to its repeat count, ${repeatCount}, but iterations ${first} to ${last} were asked for. Ask for whole iterations within that range, the first one no later than the last.`);

        const plays = this.entry.plays(first, last);
        const start = plays[0]!.start;
        if (!holdsUntilNext) return {start, duration: plays.at(-1)!.end - start, plays};

        const nextStart = this.entry.plays(last + 1, last + 1)[0]!.start;
        const hold = plays.at(-1)!.holdEnd(nextStart);
        return {start, duration: nextStart - start, plays: hold ? [...plays, hold] : plays};
    }
}

/** Backwards when it holds before, forwards when it holds after. */
function fillOf(holdsBefore: boolean, holdsAfter: boolean): FillMode {
    if (holdsBefore) return holdsAfter ? 'both' : 'backwards';
    return holdsAfter ? 'forwards' : 'none';
}
