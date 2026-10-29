import type {CSSValue} from "../dom/mapping.ts";

/** Stands for the property's value as its effect is created. */
export interface CurrentValueToken {
    type: 'currentValue';
}

/** Stands for the value `factor` of the way from `start` to `end`; a factor outside 0–1 runs past them. */
export interface InterpolatedValueToken<Value> {
    type: 'interpolated';
    start: Value;
    end: Value;
    factor: number;
}

/** Stands for a value that the stage that plays it works out. */
export type ValueToken = CurrentValueToken | InterpolatedValueToken<TrackValue>;

/** A value on a track: a given one, or a token for one. */
export type TrackValue = CSSValue | ValueToken;

export const currentValueToken: CurrentValueToken = {type: 'currentValue'};

/** `start` at 0, `end` at 1, and either one where both are the same; a token between them otherwise. */
export function interpolatedValueOf<Value>(start: Value, end: Value, factor: number): Value | InterpolatedValueToken<Value> {
    if (factor === 0 || start === end) return start;
    if (factor === 1) return end;
    return {type: 'interpolated', start, end, factor};
}
