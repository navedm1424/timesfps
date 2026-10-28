import {animation, type SpringTransitionOptions} from "timesfps";
import {
    CubicBezierEasing,
    NativeEffectsResolver,
    type NativeKeyframe,
    naming,
    plainNumberResolver,
    plan,
    SpringSplineFitter,
    TracksResolver
} from "timesfps/internals";
import {springEasingOf} from "./spring-parameters";

export interface SplinePoint {
    time: number;
    progress: number;
    /** Leads from the previous point. */
    easing?: CubicBezierEasing;
}

export interface SpringFit {
    duration: number;
    naturalFrequency: number;
    dampingRatio: number;
    splinePoints: SplinePoint[];
    /** How many keyframes the WAAPI adapter plays the spring as. */
    keyframeCount: number;
    times: number[];
    springProgresses: number[];
    splineProgresses: number[];
    /** What WAAPI plays from the adapter's keyframes. */
    keyframeProgresses: number[];
    /** The spline's progress minus the spring's. */
    splineErrors: number[];
    largestSplineError: number;
    /** The keyframes' progress minus the spring's. */
    keyframeErrors: number[];
    largestKeyframeError: number;
}

const sampleCount = 600;

export function fitSpring(transition: SpringTransitionOptions): SpringFit {
    const easing = springEasingOf(transition);
    const {spring, duration} = easing;
    const splinePoints = Object.entries(SpringSplineFitter.fit(easing))
        .map(([offset, point]) => ({time: Number(offset) * duration, ...point}))
        .sort((first, second) => first.time - second.time);

    const times = Array.from({length: sampleCount + 1}, (_, index) => duration * index / sampleCount);
    const springProgresses = times.map(time => spring.positionAt(time));
    const splineProgresses = times.map(time => splineProgressAt(splinePoints, time));
    const keyframes = keyframesOf(transition);
    const keyframeProgressAt = keyframePlaybackOf(keyframes, duration);
    const keyframeProgresses = times.map(keyframeProgressAt);
    const splineErrors = splineProgresses.map((progress, index) => progress - springProgresses[index]!);
    const keyframeErrors = keyframeProgresses.map((progress, index) => progress - springProgresses[index]!);
    return {
        duration,
        naturalFrequency: spring.naturalFrequency,
        dampingRatio: spring.dampingRatio,
        splinePoints,
        keyframeCount: keyframes.length,
        times,
        springProgresses,
        splineProgresses,
        keyframeProgresses,
        splineErrors,
        largestSplineError: Math.max(...splineErrors.map(Math.abs)),
        keyframeErrors,
        largestKeyframeError: Math.max(...keyframeErrors.map(Math.abs))
    };
}

/** The plan only takes it as the target, and the tracks are keyed by it, so a plain object stands in for an element, which the server doesn't have. */
const standInElement = {} as Element;

/** The keyframes the WAAPI adapter plays the spring as, from 0 to 1. */
function keyframesOf(transition: SpringTransitionOptions): readonly NativeKeyframe[] {
    const definition = animation(standInElement, {progress: [0, 1]}, transition);
    const tracks = NativeEffectsResolver.resolve(new TracksResolver(plan(definition, () => [standInElement]), naming).resolve(), plainNumberResolver);
    const [effect, ...others] = tracks.get(standInElement)!.progress!;
    if (!effect || others.length > 0) throw new Error("A spring on its own should play as one effect.");
    return effect.keyframes;
}

/** Plays the keyframes the way WAAPI does: each keyframe's easing runs to the next keyframe. */
function keyframePlaybackOf(keyframes: readonly NativeKeyframe[], duration: number): (time: number) => number {
    const curves = keyframes.map(({easing}) => {
        if (!easing || easing.type === "linear") return undefined;
        if (easing.type === "cubic-bezier") return new CubicBezierEasing(easing.definition);
        throw new Error(`The keyframes ease with ${easing.type}, which the fit can't play.`);
    });
    return time => {
        const offset = time / duration;
        const nextIndex = keyframes.findIndex(keyframe => keyframe.offset >= offset);
        const index = nextIndex === -1 ? keyframes.length - 1 : Math.max(1, nextIndex);
        const from = keyframes[index - 1]!;
        const to = keyframes[index]!;
        const localOffset = to.offset > from.offset ? (offset - from.offset) / (to.offset - from.offset) : 1;
        const easedProgress = curves[index - 1]?.progressAt(localOffset) ?? localOffset;
        return Number(from.value) + (Number(to.value) - Number(from.value)) * easedProgress;
    };
}

/** Each segment's easing runs between its two points, as WAAPI plays an easing between two keyframes. */
function splineProgressAt(points: readonly SplinePoint[], time: number): number {
    const nextIndex = points.findIndex(point => point.time >= time);
    const index = nextIndex === -1 ? points.length - 1 : Math.max(1, nextIndex);
    const from = points[index - 1]!;
    const to = points[index]!;
    const offset = to.time > from.time ? (time - from.time) / (to.time - from.time) : 1;
    const easedProgress = to.easing?.progressAt(offset) ?? offset;
    return from.progress + (to.progress - from.progress) * easedProgress;
}
