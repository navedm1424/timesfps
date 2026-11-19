import {AnimationTiming, type AnimationTimingOptions} from "./animation-timing.ts";
import type {AnimationValues, Target} from "./dom/mapping.ts";
import {TweenStops} from "./tween-stops.ts";

/** Defines one animation: which elements, which values, and how it moves through them. */
export function animation(target: Target, values: AnimationValues, timing: AnimationTiming | AnimationTimingOptions): AnimationDefinition {
    return new AnimationDefinition(target, values, timing);
}

/** A timing bound to targets and values, ready to play any number of times. */
export class AnimationDefinition {
    /** @internal */
    readonly timing: AnimationTiming;
    /** @internal */
    readonly target: Target;
    /** @internal */
    readonly stopsByProperty: { readonly [property: string]: TweenStops };

    /** @internal */
    constructor(target: Target, values: AnimationValues, timing: AnimationTiming | AnimationTimingOptions) {
        this.stopsByProperty = Object.fromEntries(Object
            .entries(values)
            .map(([property, rawStops]) =>
                [property, TweenStops.of(property, rawStops)]
            )
        );
        this.timing = timing instanceof AnimationTiming ? timing : AnimationTiming.of(timing);
        this.target = target;
    }
}
