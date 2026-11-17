import {AnimationTiming, type SpringTransitionOptions} from "timesfps";
import {PRECISION, SpringEasing} from "timesfps/internals";

export type SpringKind = "physical" | "duration" | "visual";

export interface SpringParameter {
    name: string;
    min: number;
    max: number;
    step: number;
    initial: number;
}

export type SpringValues = { [name: string]: number };

export const springKindLabels: { [Kind in SpringKind]: string } = {
    physical: "Physical",
    duration: "Duration",
    visual: "Visual"
};

const velocity: SpringParameter = {name: "velocity", min: -20, max: 20, step: 0.5, initial: 0};
const bounce: SpringParameter = {name: "bounce", min: -0.9, max: 0.95, step: 0.05, initial: 0.3};

export const parametersByKind: { [Kind in SpringKind]: SpringParameter[] } = {
    physical: [
        {name: "stiffness", min: 1, max: 1000, step: 1, initial: 260},
        {name: "damping", min: 0.5, max: 100, step: 0.5, initial: 22},
        {name: "mass", min: 0.1, max: 10, step: 0.1, initial: 1},
        {name: "restDelta", min: 0.0001, max: 0.01, step: 0.0001, initial: PRECISION},
        velocity
    ],
    duration: [
        {name: "duration", min: 0.1, max: 3, step: 0.05, initial: 0.8},
        bounce,
        velocity
    ],
    visual: [
        {name: "visualDuration", min: 0.1, max: 2, step: 0.05, initial: 0.5},
        bounce,
        velocity
    ]
};

export const initialValuesByKind = Object.fromEntries(Object.entries(parametersByKind).map(([kind, parameters]) =>
    [kind, Object.fromEntries(parameters.map(({name, initial}) => [name, initial]))]
)) as { [Kind in SpringKind]: SpringValues };

export function transitionOf(kind: SpringKind, values: SpringValues): SpringTransitionOptions {
    switch (kind) {
        case "physical":
            return {stiffness: values.stiffness!, damping: values.damping!, mass: values.mass!, restDelta: values.restDelta!, velocity: values.velocity!};
        case "duration":
            return {duration: values.duration!, bounce: values.bounce!, velocity: values.velocity!};
        case "visual":
            return {visualDuration: values.visualDuration!, bounce: values.bounce!, velocity: values.velocity!};
    }
}

/** Stiffness, damping and mass that follow the same equation as the transition, with its velocity in progress per second. */
export function physicsOf(transition: SpringTransitionOptions) {
    const {naturalFrequency, dampingRatio, initialVelocity} = springEasingOf(transition).spring;
    return {
        stiffness: naturalFrequency * naturalFrequency,
        damping: 2 * dampingRatio * naturalFrequency,
        mass: 1,
        velocity: initialVelocity
    };
}

/** The spring the transition plays, over the time it runs. */
export function springEasingOf(transition: SpringTransitionOptions): SpringEasing {
    const {easing} = AnimationTiming.of(transition);
    if (!(easing instanceof SpringEasing)) throw new TypeError("The transition isn't a spring.");
    return easing;
}
