import type {CubicBezier} from "../cubic-bezier.ts";
import {CubicBezierEasing, type CubicBezierEasingParams, type Easing, LinearEasing, SpringEasing, StepsEasing} from "../easing.ts";
import {linear} from "../easing-specifier.ts";
import type {DampedSpring} from "../damped-spring.ts";
import type {Progress, Seconds} from "../types.ts";
import {clamp, invLerp, lerp} from "../utils/math.ts";
import {sortedEntriesOf} from "../utils/records.ts";
import type {LinearPoint, NativeEasing} from "./native-easing.ts";
import type {Segment} from "./segment.ts";
import {type Spline, SpringSplineFitter} from "./spring-fit.ts";
import type {TrackValues} from "./track-values.ts";

/** `easing` leads to the next keyframe; without one, it's linear. The value is CSS text. */
export interface NativeKeyframe {
    offset: number;
    value: string;
    easing?: NativeEasing;
}

/**
 * The easing and keyframes of an effect of `duration` that plays the segments, with their values' texts from `values`.
 * A single whole iteration keeps its easing on the effect, with the stops as linear keyframes; otherwise the easings are windowed and split into the keyframes.
 */
export function easingAndKeyframesOf(segments: readonly Segment[], duration: Seconds, values: TrackValues): { easing: NativeEasing; keyframes: NativeKeyframe[] } {
    if (easesOnEffect(segments)) {
        const [segment] = segments;
        return {easing: wholeNativeEasingOf(segment!.windowedEasing), keyframes: segment!.stops.map(({offset, value}) => ({offset, value}))};
    }
    if (duration === 0)
        return {easing: {type: 'linear'}, keyframes: [{offset: 0, value: startTextOf(segments[0]!, values)}, {offset: 1, value: endTextOf(segments.at(-1)!, values)}]};
    return {easing: {type: 'linear'}, keyframes: keyframesOf(segments, values)};
}

/** The text of the value the segment starts on. */
function startTextOf(segment: Segment, values: TrackValues): string {
    return values.textAt(segment.stops, segment.startProgress);
}

/** The text of the value the segment ends on. */
export function endTextOf(segment: Segment, values: TrackValues): string {
    return values.textAt(segment.stops, segment.endProgress);
}

function easesOnEffect(segments: readonly Segment[]): boolean {
    const [segment, ...otherSegments] = segments;
    return !!segment && otherSegments.length === 0 && segment.startOffset === 0 && segment.endOffset === 1 && runsOnEffect(segment);
}

function runsOnEffect({windowedEasing, stops}: Segment): boolean {
    return windowedEasing.isWhole && !(windowedEasing instanceof SpringEasing) && stops.every(({offset}) => offset >= 0 && offset <= 1);
}

function wholeNativeEasingOf(easing: Easing): NativeEasing {
    if (easing instanceof CubicBezierEasing) return {type: 'cubic-bezier', definition: easing.params};
    if (easing instanceof StepsEasing) return {type: 'steps', definition: easing.params};
    return {type: 'linear'};
}

function keyframesOf(segments: readonly Segment[], values: TrackValues): NativeKeyframe[] {
    const keyframes: NativeKeyframe[] = [];
    for (const segment of segments) {
        if (segment.endOffset < segment.startOffset) continue;
        const offsetAt = (segmentOffset: number) => lerp(segment.startOffset, segment.endOffset, segmentOffset);
        for (const piece of keyframedPiecesOf(segment, values)) {
            const startOffset = offsetAt(piece.startOffset);
            const last = keyframes.at(-1);
            if (last && last.offset === startOffset && last.value === piece.startValue) {
                if (piece.easing) last.easing = piece.easing;
            } else
                keyframes.push({offset: startOffset, value: piece.startValue, ...(piece.easing && {easing: piece.easing})});
            keyframes.push({offset: offsetAt(piece.endOffset), value: piece.endValue});
        }
    }

    // Rounding may leave offsets a hair outside 0–1 or out of order, which WAAPI rejects.
    let previousOffset = 0;
    for (const keyframe of keyframes)
        previousOffset = keyframe.offset = clamp(keyframe.offset, previousOffset, 1);
    return keyframes;
}

/** A stretch of a segment between two keyframes, with their values' texts; offsets are fractions of the segment. */
interface KeyframedPiece {
    startOffset: number;
    endOffset: number;
    startValue: string;
    endValue: string;
    easing?: NativeEasing;
}

/** A part of a segment's windowed easing whose progress is `fromProgress` to `toProgress` scaled by its own; offsets are fractions of the segment. */
interface CurveSegment {
    startOffset: number;
    endOffset: number;
    easing: Easing;
    fromProgress: Progress;
    toProgress: Progress;
}

/**
 * The segment as pieces that each ease between two values: one jump for a jump.
 * Otherwise its windowed easing is split wherever it passes a stop, and wherever it turns back, so the value runs linearly with the progress within each piece.
 * With only two stops, it runs so everywhere, even past them, so only a spring's turns split it.
 */
function keyframedPiecesOf(segment: Segment, values: TrackValues): KeyframedPiece[] {
    const {windowedEasing: easing, stops} = segment;
    if (segment.isJump) return [{startOffset: 0, endOffset: 1, startValue: startTextOf(segment, values), endValue: endTextOf(segment, values)}];
    const curveSegments = stops.length === 2 && !(easing instanceof SpringEasing) ? curveSegmentsOf(easing) : curveSegmentsOf(easing).flatMap(splitAtTurningPoints);
    return curveSegments.flatMap(curveSegment => splitAtStops(curveSegment, segment, values));
}

/** A spring as the segments of its fitted spline within the window; any other easing as one segment. */
function curveSegmentsOf(easing: Easing): CurveSegment[] {
    if (!(easing instanceof SpringEasing))
        return [{startOffset: 0, endOffset: 1, easing, fromProgress: 0, toProgress: 1}];

    const {windowStart, windowEnd} = easing;
    const [low, high] = windowStart <= windowEnd ? [windowStart, windowEnd] : [windowEnd, windowStart];
    const points = splinePointsOf(easing);
    return points.slice(1).flatMap(([endInput, {progress: toProgress, easing: pieceEasing = linear}], index): CurveSegment[] => {
        const [startInput, {progress: fromProgress}] = points[index]!;
        const coveredStart = Math.max(startInput, low);
        const coveredEnd = Math.min(endInput, high);
        if (coveredEnd <= coveredStart) return [];

        const [entry, exit] = windowStart <= windowEnd ? [coveredStart, coveredEnd] : [coveredEnd, coveredStart];
        const pieceOffsetOf = (input: number) => invLerp(startInput, endInput, input);
        return [{
            startOffset: invLerp(windowStart, windowEnd, entry),
            endOffset: invLerp(windowStart, windowEnd, exit),
            easing: pieceEasing.segment(pieceOffsetOf(entry), pieceOffsetOf(exit)),
            fromProgress,
            toProgress
        }];
    }).sort((first, second) => first.startOffset - second.startOffset);
}

const splinesBySpring = new WeakMap<DampedSpring, Map<Seconds, [number, Spline[number]][]>>();

/** Fitted once per spring and duration, whatever the window. */
function splinePointsOf(easing: SpringEasing): [number, Spline[number]][] {
    let splinesByDuration = splinesBySpring.get(easing.spring);
    if (!splinesByDuration) splinesBySpring.set(easing.spring, splinesByDuration = new Map());
    let points = splinesByDuration.get(easing.duration);
    if (!points) splinesByDuration.set(easing.duration, points = sortedEntriesOf(SpringSplineFitter.fit(easing)));
    return points;
}

function splitAtTurningPoints(segment: CurveSegment): CurveSegment[] {
    const boundaries = [0, ...segment.easing.turningOffsets(), 1];
    return boundaries.slice(1).map((end, index) => {
        const start = boundaries[index]!;
        return {
            ...segment,
            startOffset: lerp(segment.startOffset, segment.endOffset, start),
            endOffset: lerp(segment.startOffset, segment.endOffset, end),
            easing: segment.easing.segment(start, end)
        };
    });
}

/** Between two passes of stops, the curve segment's value runs linearly with its progress, so it eases between their values; a piece that splits further takes values between them. */
function splitAtStops({startOffset, endOffset, easing, fromProgress, toProgress}: CurveSegment, segment: Segment, values: TrackValues): KeyframedPiece[] {
    const progressOf = (easedProgress: Progress) => lerp(fromProgress, toProgress, easedProgress);
    const startEased = easing.startProgress;
    const endEased = easing.endProgress;
    const {stops} = segment;
    const crossings = segment
        .stopsBetween(progressOf(startEased), progressOf(endEased))
        .flatMap(({offset: progress, value}) => {
            const eased = invLerp(fromProgress, toProgress, progress);
            const [offset] = easing.offsetsAt(eased);
            return offset === undefined ? [] : [{offset, eased, value}];
        })
        .sort((first, second) => first.offset - second.offset);
    const bounds = [
        {offset: 0, eased: startEased, value: values.textAt(stops, progressOf(startEased))},
        ...crossings,
        {offset: 1, eased: endEased, value: values.textAt(stops, progressOf(endEased))}
    ];

    return bounds.slice(1).flatMap((end, index) => {
        const start = bounds[index]!;
        if (end.offset <= start.offset) return [];

        const segmentOffsetOf = (pieceOffset: number) => lerp(startOffset, endOffset, lerp(start.offset, end.offset, pieceOffset));
        const pieces = nativePiecesOf(easing.segment(start.offset, end.offset), start.eased, end.eased);
        return pieces.map((piece, pieceIndex): KeyframedPiece => {
            const previous = pieces[pieceIndex - 1] ?? {offset: 0, progress: 0};
            return {
                startOffset: segmentOffsetOf(previous.offset),
                endOffset: segmentOffsetOf(piece.offset),
                startValue: values.textBetween(start.value, end.value, previous.progress),
                endValue: values.textBetween(start.value, end.value, piece.progress),
                ...(piece.easing && {easing: piece.easing})
            };
        });
    });
}

/** A piece of a split easing, rescaled to 0–1, ending at `offset` where the whole runs `progress` of the way. */
interface NativePiece {
    offset: number;
    progress: Progress;
    easing?: NativeEasing;
}

/** The window as native easings that run from `startEased` to `endEased`, which steps only reach as they jump past them. */
function nativePiecesOf(easing: Easing, startEased: Progress, endEased: Progress): NativePiece[] {
    if (startEased === endEased || easing instanceof LinearEasing) return [{offset: 1, progress: 1}];
    if (easing instanceof CubicBezierEasing) return cubicBezierPiecesOf(easing);
    if (easing instanceof StepsEasing) return [{offset: 1, progress: 1, easing: stepsEasingOf(easing, startEased, endEased)}];
    throw new Error("A spring's window must be fitted before it's made native.");
}

const timeTolerance = 1e-9;

/** The window cut out of the curve and stretched to (0, 0)–(1, 1), as one piece or two. */
function cubicBezierPiecesOf(easing: CubicBezierEasing): NativePiece[] {
    const {curve, windowStart, windowEnd} = easing;
    const [low, high] = windowStart <= windowEnd ? [windowStart, windowEnd] : [windowEnd, windowStart];
    const lowParameter = curve.parameterAt('x', low);
    const highParameter = curve.parameterAt('x', high);
    const [, fromLow] = curve.splitAt(lowParameter);
    const [window] = fromLow.splitAt(invLerp(lowParameter, 1, highParameter));
    const forwardPieces = stretchedPiecesOf(window);
    const pieces = windowStart <= windowEnd ? forwardPieces : forwardPieces.map((piece, index): StretchedPiece => {
        const start = forwardPieces[index - 1] ?? {offset: 0, progress: 0};
        const [x1, y1, x2, y2] = piece.definition;
        return {offset: 1 - start.offset, progress: 1 - start.progress, definition: [1 - x2, 1 - y2, 1 - x1, 1 - y1]};
    }).reverse();
    return pieces.map(({offset, progress, definition}) => ({offset, progress, easing: {type: 'cubic-bezier', definition}}));
}

interface StretchedPiece {
    offset: number;
    progress: Progress;
    definition: CubicBezierEasingParams;
}

/**
 * The curve as one piece, or as two when stretching it would push its handles outside the 0–1 time range.
 * That only happens to a piece that contains the point where time moves slowest, and splitting there always fixes it.
 */
function stretchedPiecesOf(curve: CubicBezier): StretchedPiece[] {
    const [x1, , x2] = stretchedDefinitionOf(curve);
    const inflection = curve.inflectionParameter('x');
    const fitsInTime = isWithinTime(x1) && isWithinTime(x2);
    const parts = fitsInTime || inflection === undefined || inflection <= 0 || inflection >= 1 ? [curve] : curve.splitAt(inflection);
    const clampToTime = (x: number) => clamp(x, 0, 1);
    return parts.map(part => {
        const [x1, y1, x2, y2] = stretchedDefinitionOf(part);
        return {
            offset: invLerp(curve.start.x, curve.end.x, part.end.x),
            progress: invLerp(curve.start.y, curve.end.y, part.end.y),
            definition: [clampToTime(x1), y1, clampToTime(x2), y2]
        };
    });
}

function isWithinTime(x: number): boolean {
    return x >= -timeTolerance && x <= 1 + timeTolerance;
}

/** The control points of the curve stretched to run from (0, 0) to (1, 1). */
function stretchedDefinitionOf(curve: CubicBezier): CubicBezierEasingParams {
    const {start, end} = curve;
    const stretch = ({x, y}: { x: number; y: number }) => [invLerp(start.x, end.x, x), invLerp(start.y, end.y, y)] as const;
    return [...stretch(curve.control1), ...stretch(curve.control2)];
}

/** The window's levels as a `linear()` with hard jumps, or the steps themselves when the window is the whole easing and runs 0 to 1. */
function stepsEasingOf(easing: StepsEasing, startEased: Progress, endEased: Progress): NativeEasing {
    if (easing.isWhole && startEased === 0 && endEased === 1) return {type: 'steps', definition: easing.params};

    const bounds = [0, ...easing.jumpOffsets(), 1];
    const points: LinearPoint[] = [{input: 0, output: 0}];
    bounds.slice(1).forEach((end, index) => {
        const start = bounds[index]!;
        const level = invLerp(startEased, endEased, easing.progressAt((start + end) / 2));
        points.push({input: start, output: level}, {input: end, output: level});
    });
    points.push({input: 1, output: 1});
    return {type: 'linear-points', points: points.filter((point, index) => {
        const previous = points[index - 1];
        return !previous || previous.input !== point.input || previous.output !== point.output;
    })};
}
