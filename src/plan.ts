import type {AnimationDefinition} from "./animation.ts";
import {type EntrySpan, type PositionDescriptor, resolvePosition} from "./at.ts";
import {type Target} from "./dom/mapping.ts";
import type {Easing} from "./easing.ts";
import type {RepeatOptions} from "./playback-options.ts";
import {type Definition, SequenceDefinition, type SequenceDefinitionEntry} from "./sequence.ts";
import {resolveTransition} from "./transition.ts";
import type {TweenStops} from "./tween-stops.ts";
import type {Seconds} from "./types.ts";

/**
 * What every other iteration of an oscillating repeat flips: its time, so it plays backwards,
 * or its values, so it runs from the end values to the start ones with its easing forwards.
 */
export type Oscillation = 'time' | 'values';

/**
 * How an entry repeats after its first iteration: the plan's form of its repeat options, unlike a playback descriptor, which keeps them as repeat options.
 * One without duration doesn't repeat.
 */
export interface RepeatDescriptor {
    /** How many iterations follow its first; `Infinity` repeats forever. */
    repeatCount: number;
    /** How long it holds the value it ends on before each repeat. */
    repeatDelay: Seconds;
    /** Without it, every repeat starts over. */
    oscillate?: Oscillation;
}

/** Times are after the outermost definition starts. */
interface PlanBase extends RepeatDescriptor {
    /** Where it starts, before its delay; what `<` refers to. */
    start: Seconds;
    /** How long one iteration of an animation, or a sequence, lasts, without delays or repeats; an animation with no targets takes no time. */
    iterationDuration: Seconds;
}

/** A target of an animation, with where the animation starts on it: after the animation's own delay for it. */
export interface StaggeredTarget {
    target: Element;
    start: Seconds;
}

export interface AnimationPlan extends PlanBase {
    type: 'animation';
    stopsByProperty: { readonly [property: string]: TweenStops };
    /** The easing one iteration runs. */
    easing: Easing;
    targets: readonly StaggeredTarget[];
}

/** It doesn't repeat until sequences can. */
export interface SequencePlan extends PlanBase {
    type: 'sequence';
    entries: ReadonlyMap<string, Plan>;
}

export type Plan = AnimationPlan | SequencePlan;

type TargetsResolver = (target: Target) => readonly Element[];

/** A target of an animation, with the animation's own delay for it. */
interface DelayedTarget {
    target: Element;
    delay: Seconds;
}

/** Resolves the definition's targets, and places every entry, and every target of each, in time. */
export function plan(definition: AnimationDefinition, resolveTargets: TargetsResolver): AnimationPlan;
export function plan(definition: SequenceDefinition, resolveTargets: TargetsResolver): SequencePlan;
export function plan(definition: Definition, resolveTargets: TargetsResolver): Plan;
export function plan(definition: Definition, resolveTargets: TargetsResolver): Plan {
    return definition instanceof SequenceDefinition
        ? SequencePlanner.of(definition, resolveTargets).plan(0)
        : AnimationPlanner.of(definition, resolveTargets).plan(0);
}

/** Plans an entry from its definition, which gives its duration, then its position among the entries before it. */
abstract class EntryPlanner {
    protected entryPosition: Seconds = 0;

    protected constructor(
        /** Its duration for positions, from its position to where `>` refers to: its delay and repeats included, of which an infinite repeat counts its first iteration only. */
        protected readonly spanDuration: Seconds
    ) {}

    /** Resolves its position among the entries before it, clamped to the start of the sequence. */
    position(descriptor: PositionDescriptor<string>, entrySpans: ReadonlyMap<string, EntrySpan>): this {
        this.entryPosition = Math.max(0, resolvePosition(descriptor, entrySpans, this.spanDuration));
        return this;
    }

    get span(): EntrySpan {
        return {start: this.entryPosition, duration: this.spanDuration};
    }

    /** Its plan, in the sequence it's in, which starts at `sequenceStart`. */
    abstract plan(sequenceStart: Seconds): Plan;
}

class AnimationPlanner extends EntryPlanner {
    private constructor(
        private readonly stopsByProperty: { readonly [property: string]: TweenStops },
        private readonly targets: readonly DelayedTarget[],
        private readonly iterationDuration: Seconds,
        spanDuration: Seconds,
        private readonly easing: Easing,
        private readonly repeatDescriptor: RepeatDescriptor
    ) {
        super(spanDuration);
    }

    static of(definition: AnimationDefinition, resolveTargets: TargetsResolver): AnimationPlanner {
        const elements = resolveTargets(definition.target);
        const count = elements.length;

        const {delay = 0, ...repeatOptions} = definition.timing.playback;
        const targets = elements.map((target, index): DelayedTarget => ({target, delay: typeof delay === 'function' ? delay(index, count) : delay}));

        const {duration, easing} = resolveTransition(definition.timing.transition);
        const iterationDuration = count ? duration : 0;
        const spanDuration = count ? Math.max(...targets.map(target => target.delay)) + iterationsSpanDuration(iterationDuration, repeatOptions) : 0;

        return new AnimationPlanner(definition.stopsByProperty, targets, iterationDuration, spanDuration, easing, repeatDescriptorOf(iterationDuration, repeatOptions));
    }

    plan(sequenceStart: Seconds): AnimationPlan {
        const start = sequenceStart + this.entryPosition;
        return {
            type: 'animation',
            stopsByProperty: this.stopsByProperty,
            easing: this.easing,
            targets: this.targets.map(({target, delay}) => ({target, start: start + delay})),
            start,
            iterationDuration: this.iterationDuration,
            ...this.repeatDescriptor
        };
    }
}

/** A sequence lasts until the latest end among its entries, which is also its duration for positions. */
class SequencePlanner extends EntryPlanner {
    private constructor(
        private readonly entries: ReadonlyMap<string, EntryPlanner>,
        private readonly iterationDuration: Seconds
    ) {
        super(iterationDuration);
    }

    /** Makes a planner for each entry, and positions it once, among the entries before it. */
    static of(definition: SequenceDefinition, resolveTargets: TargetsResolver): SequencePlanner {
        const entries = new Map<string, EntryPlanner>();
        const entrySpans = new Map<string, EntrySpan>();
        definition.timing.entries.forEach(({name, position}, index) => {
            const planner = entryPlannerOf(definition.entries[index]!, resolveTargets).position(position, entrySpans);
            entrySpans.set(name, planner.span);
            entries.set(name, planner);
        });

        const iterationDuration = Math.max(0, ...[...entrySpans.values()].map(({start, duration}) => start + duration));
        return new SequencePlanner(entries, iterationDuration);
    }

    /** Plans each entry in it, from where it starts. */
    plan(sequenceStart: Seconds): SequencePlan {
        const start = sequenceStart + this.entryPosition;
        return {
            type: 'sequence',
            entries: new Map([...this.entries].map(([name, planner]) => [name, planner.plan(start)])),
            start,
            iterationDuration: this.iterationDuration,
            repeatCount: 0,
            repeatDelay: 0
        };
    }
}

function entryPlannerOf(entry: SequenceDefinitionEntry, resolveTargets: TargetsResolver): EntryPlanner {
    return 'sequence' in entry ? SequencePlanner.of(entry.sequence, resolveTargets) : AnimationPlanner.of(entry.animation, resolveTargets);
}

/** How an entry with iterations of `iterationDuration` repeats, as `repeatOptions` say; one without duration or repeats doesn't repeat at all. */
function repeatDescriptorOf(iterationDuration: Seconds, {repeat = 0, repeatDelay = 0, repeatMode = 'loop'}: RepeatOptions): RepeatDescriptor {
    if (iterationDuration === 0 || repeat === 0) return {repeatCount: 0, repeatDelay: 0};
    const oscillate: Oscillation | undefined = repeatMode === 'reverse' ? 'time' : repeatMode === 'mirror' ? 'values' : undefined;
    return {repeatCount: repeat, repeatDelay, ...(oscillate && {oscillate})};
}

/** The iterations and their repeat delays; only the first iteration when it repeats forever. */
function iterationsSpanDuration(iterationDuration: Seconds, {repeat = 0, repeatDelay = 0}: RepeatOptions): Seconds {
    if (repeat === Infinity) return iterationDuration;
    return iterationDuration * (repeat + 1) + repeatDelay * repeat;
}
