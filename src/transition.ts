import {PRECISION} from "./constants.ts";
import {DampedSpring} from "./damped-spring.ts";
import {type Easing, SpringEasing} from "./easing.ts";
import {checkEasingSpecifier, type EasingSpecifier, resolveEasing} from "./easing-specifier.ts";
import type {Progress, Seconds} from "./types.ts";
import {LeastRecentlyUsedCache} from "./utils/collections.ts";
import {checkNumber, checkPositive, requireNumber, requireProperty} from "./utils/validation.ts";

type ElementOf<A extends readonly string[]> = A extends readonly (infer ArrayElement)[] ? ArrayElement : never;

const groupedTransitionKeys = {
    eased: ['duration', 'easing'],
    durationSpring: ['duration', 'bounce', 'velocity'],
    visualSpring: ['visualDuration', 'bounce', 'velocity'],
    physicalSpring: ['stiffness', 'damping', 'mass', 'velocity', 'restDelta']
} as const satisfies {
    [kind: string]: string[];
};

type TransitionKind = keyof typeof groupedTransitionKeys;
type TransitionKey<Kind extends TransitionKind = TransitionKind> = ElementOf<typeof groupedTransitionKeys[Kind]>;

type OtherKeysExcluded<Kind extends TransitionKind> = { [Key in Exclude<TransitionKey, TransitionKey<Kind>>]?: never; };

/** A timed transition with an easing; it's the kind a `duration` without a `bounce` is. */
export interface EasedTransitionOptions extends OtherKeysExcluded<"eased"> {
    duration: Seconds;
    easing?: EasingSpecifier;
}

interface SharedSpringOptions {
    /** Normalized change per second */
    velocity?: number;
}

/** Shaped by `bounce` and stretched so it comes to rest at the end of `duration`. */
export interface DurationSpringTransitionOptions extends SharedSpringOptions, OtherKeysExcluded<"durationSpring"> {
    duration: Seconds;
    /** 0 = no overshoot */
    bounce: number;
}

/** Shaped by `bounce`, with `visualDuration` setting how fast it swings; it runs on past it until it comes to rest. */
export interface VisualSpringTransitionOptions extends SharedSpringOptions, OtherKeysExcluded<"visualSpring"> {
    visualDuration: Seconds;
    /** 0 = no overshoot */
    bounce: number;
}

/** Works out its own duration. */
export interface PhysicalSpringTransitionOptions extends SharedSpringOptions, OtherKeysExcluded<"physicalSpring"> {
    stiffness: number;
    damping: number;
    mass?: number;
    restDelta?: Progress;
}

export type SpringTransitionOptions = DurationSpringTransitionOptions | VisualSpringTransitionOptions | PhysicalSpringTransitionOptions;

export type TransitionOptions = EasedTransitionOptions | SpringTransitionOptions;

// /** Duration comes from the animation's ratio, so only transitions shaped by a given duration fit. */
// export type StretchableTransition =
//     | Omit<EasedTransitionOptions, 'duration'>
//     | Omit<DurationSpringTransitionOptions, 'duration'>;

const transitionKeyEntries = Object.entries(groupedTransitionKeys);
const transitionKeySetByKind = Object.fromEntries(
    transitionKeyEntries.map(([k, v]) => [k, new Set(v)])
) as { [K in TransitionKind]: Set<string>; };
const transitionKeySet = new Set<string>(transitionKeyEntries.flatMap(([, k]) => k));

/** The keys a transition can have, which never overlap a timing's options. */
export function isTransitionKey(key: string): boolean {
    return transitionKeySet.has(key);
}

/** Physical with `stiffness` or `damping`, visual with `visualDuration`, a duration spring with `bounce`, and eased otherwise. */
function transitionKindOf(transition: TransitionOptions): TransitionKind {
    if (transition.stiffness !== undefined || transition.damping !== undefined) return 'physicalSpring';
    if (transition.visualDuration !== undefined) return 'visualSpring';
    if (transition.bounce !== undefined) return 'durationSpring';
    return 'eased';
}

/** Rejects keys of another kind, what no play can run, and every spring that can't come to rest, before it reaches the spring's own checks. */
export function checkTransitionOptions(transition: TransitionOptions, label: string): void {
    const kind = transitionKindOf(transition);
    const kindKeys = transitionKeySetByKind[kind];
    const strayKey = Object.keys(transition).find(key =>
        isTransitionKey(key) && !kindKeys.has(key) && transition[key as TransitionKey] !== undefined
    );
    if (strayKey !== undefined)
        throw new TypeError(`${label} has "${strayKey}", which a transition with ${[...kindKeys].map(key => `"${key}"`).join(', ')} doesn't take.`);

    checkNumber(transition.velocity, `${label}'s velocity`);
    switch (kind) {
        case 'eased':
            requireNumber(transition.duration, `${label}'s duration`);
            if (checkNumber(transition.duration, `${label}'s duration`) < 0)
                throw new RangeError(`${label}'s duration can't be negative, not ${transition.duration}.`);
            if (transition.easing !== undefined) checkEasingSpecifier(transition.easing, `${label}'s easing`);
            return;
        case 'physicalSpring': {
            requireNumber(transition.stiffness, `${label}'s stiffness`);
            requireNumber(transition.damping, `${label}'s damping`);
            checkPositive(transition.stiffness, `${label}'s stiffness`);
            checkPositive(transition.damping, `${label}'s damping`);
            checkPositive(transition.mass, `${label}'s mass`);
            const {restDelta} = transition;
            if (checkNumber(restDelta, `${label}'s rest delta`) !== undefined && !(restDelta! > 0 && restDelta! < 1))
                throw new RangeError(`${label}'s rest delta must be between 0 and 1, not ${restDelta}.`);
            return;
        }
        case 'visualSpring':
            requireProperty(transition, 'bounce', `${label}'s bounce`);
            checkBounce(transition.bounce, label);
            checkPositive(transition.visualDuration, `${label}'s visual duration`);
            return;
        case 'durationSpring':
            checkBounce(transition.bounce, label);
            requireNumber(transition.duration, `${label}'s duration`);
            checkPositive(transition.duration, `${label}'s duration`);
            return;
    }
}

function checkBounce(bounce: number | undefined, label: string): void {
    if (!(bounce! > -1 && bounce! < 1))
        throw new RangeError(`${label}'s bounce must be between -1 and 1, not ${bounce}.`);
}

/** A transition as it plays: how long one iteration lasts, and the easing it runs. */
export interface TransitionDescriptor {
    duration: Seconds;
    easing: Easing;
}

/** A transition with its kind and every default filled in, so equal ones look alike. */
type FilledTransition =
    | { kind: 'eased'; duration: Seconds; easing: EasingSpecifier }
    | { kind: 'physicalSpring'; stiffness: number; damping: number; mass: number; velocity: number; restDelta: Progress }
    | { kind: 'visualSpring'; visualDuration: Seconds; bounce: number; velocity: number }
    | { kind: 'durationSpring'; duration: Seconds; bounce: number; velocity: number };

function filledTransitionOf(transition: TransitionOptions): FilledTransition {
    switch (transitionKindOf(transition)) {
        case 'eased': {
            const {duration, easing = 'linear'} = transition as EasedTransitionOptions;
            return {kind: 'eased', duration, easing};
        }
        case 'physicalSpring': {
            const {stiffness, damping, mass = 1, velocity = 0, restDelta = PRECISION} = transition as PhysicalSpringTransitionOptions;
            return {kind: 'physicalSpring', stiffness, damping, mass, velocity, restDelta};
        }
        case 'visualSpring': {
            const {visualDuration, bounce, velocity = 0} = transition as VisualSpringTransitionOptions;
            return {kind: 'visualSpring', visualDuration, bounce, velocity};
        }
        case 'durationSpring': {
            const {duration, bounce, velocity = 0} = transition as DurationSpringTransitionOptions;
            return {kind: 'durationSpring', duration, bounce, velocity};
        }
    }
}

/** How many resolved transitions are kept; velocities that come from gestures would otherwise add one each, forever. */
const maxResolvedTransitions = 64;
const resolvedTransitions = new LeastRecentlyUsedCache<string, TransitionDescriptor>(maxResolvedTransitions);

/** How long one iteration of the transition lasts, and the easing it runs; equal transitions resolved recently share one descriptor, and so one easing. */
export function resolveTransition(transition: TransitionOptions): TransitionDescriptor {
    const filled = filledTransitionOf(transition);
    return resolvedTransitions.getOrInsertComputed(JSON.stringify(filled), () => resolvedTransitionOf(filled));
}

function resolvedTransitionOf(transition: FilledTransition): TransitionDescriptor {
    switch (transition.kind) {
        case 'eased':
            return {duration: transition.duration, easing: resolveEasing(transition.easing)};
        case 'physicalSpring': {
            const {stiffness, damping, mass, velocity, restDelta} = transition;
            return transitionDescriptorOf(DampedSpring.physical(stiffness, damping, mass, velocity), restDelta);
        }
        case 'visualSpring': {
            const {visualDuration, bounce, velocity} = transition;
            return transitionDescriptorOf(DampedSpring.visual(visualDuration, bounce, velocity), PRECISION);
        }
        case 'durationSpring': {
            const {duration, bounce, velocity} = transition;
            return {duration, easing: new SpringEasing(DampedSpring.restingAt(duration, bounce, velocity, PRECISION), duration)};
        }
    }
}

/** A spring runs until it comes to rest. */
function transitionDescriptorOf(spring: DampedSpring, restDelta: Progress): TransitionDescriptor {
    const duration = spring.restTime(restDelta);
    return {duration, easing: new SpringEasing(spring, duration)};
}
