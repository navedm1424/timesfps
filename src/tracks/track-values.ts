import type {CSSValue} from "../dom/mapping.ts";

/** Stands for the property's value as its effect is created. */
export interface CurrentValueToken {
    type: 'currentValue';
}

/** Stands for the value `factor` of the way from `from` to `to`; a factor outside 0–1 runs past them. */
export interface InterpolatedValueToken<Value> {
    type: 'interpolated';
    from: Value;
    to: Value;
    factor: number;
}

/** Stands for a value that the stage that plays it works out. */
export type ValueToken = CurrentValueToken | InterpolatedValueToken<TrackValue>;

/** A value on a track: a given one, or a token for one. */
export type TrackValue = CSSValue | ValueToken;

export const currentValueToken: CurrentValueToken = {type: 'currentValue'};

/** `from` at 0, `to` at 1, and either one where both are the same; a token between them otherwise. */
export function interpolatedValueOf<Value>(from: Value, to: Value, factor: number): Value | InterpolatedValueToken<Value> {
    if (factor === 0 || from === to) return from;
    if (factor === 1) return to;
    return {type: 'interpolated', from, to, factor};
}
