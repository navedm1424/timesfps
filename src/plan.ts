import type {AnimationDefinition} from "./animation.ts";
import type {AnimationTiming} from "./animation-timing.ts";
import {type PositionDescriptor, resolvePosition, type Span} from "./at.ts";
import {type Target} from "./dom/mapping.ts";
import type {Easing} from "./easing.ts";
import type {RepeatDescriptor} from "./playback-options.ts";
import {type Definition, SequenceDefinition, type SequenceDefinitionEntry} from "./sequence.ts";
import type {TweenStops} from "./tween-stops.ts";
import type {Seconds} from "./types.ts";

/** Times are after the outermost definition starts. */
interface PlanBase extends RepeatDescriptor {
    /** Where it starts, before its delay; what `<` refers to. */
    start: Seconds;
    /** How long one iteration of an animation, or a sequence, lasts, without delays or repeats. */
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

/** It doesn't repeat until sequences can, and has only the entries that play something. */
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

/** Resolves the definition's targets, and places every entry, and every target of each, in time; `undefined` when none of it has targets, so it plays nothing. */
export function plan(definition: AnimationDefinition, resolveTargets: TargetsResolver): AnimationPlan | undefined;
export function plan(definition: SequenceDefinition, resolveTargets: TargetsResolver): SequencePlan | undefined;
export function plan(definition: Definition, resolveTargets: TargetsResolver): Plan | undefined;
export function plan(definition: Definition, resolveTargets: TargetsResolver): Plan | undefined {
    return definition instanceof SequenceDefinition
        ? SequencePlanner.of(definition, resolveTargets).plan(0)
        : AnimationPlanner.of(definition, resolveTargets).plan(0);
}

/** Plans an entry from its definition, which gives its duration, then its position among the entries before it. */
abstract class Planner {
    protected localStart: Seconds = 0;

    protected constructor(
        /** Its duration for positions, from its position to where `>` refers to: its delay and repeats included, of which an infinite repeat counts its first iteration only. */
        protected readonly referenceDuration: Seconds
    ) {}

    /** Resolves its position among the entries before it, clamped to the start of the sequence. */
    position(descriptor: PositionDescriptor<string>, referenceSpans: ReadonlyMap<string, Span>): this {
        this.localStart = Math.max(0, resolvePosition(descriptor, referenceSpans, this.referenceDuration));
        return this;
    }

    get referenceSpan(): Span {
        return {start: this.localStart, duration: this.referenceDuration};
    }

    /** Its plan, in the sequence it's in, which starts at `sequenceStart`; `undefined` when nothing in it has targets, though it still keeps its position for the entries after it. */
    abstract plan(sequenceStart: Seconds): Plan | undefined;
}

class AnimationPlanner extends Planner {
    private constructor(
        private readonly stopsByProperty: { readonly [property: string]: TweenStops },
        private readonly targets: readonly DelayedTarget[],
        private readonly timing: AnimationTiming,
        referenceDuration: Seconds
    ) {
        super(referenceDuration);
    }

    /** One without targets takes no time. */
    static of(definition: AnimationDefinition, resolveTargets: TargetsResolver): AnimationPlanner {
        const elements = resolveTargets(definition.target);
        const count = elements.length;

        const {timing} = definition;
        const {delay, duration, repeat} = timing;
        const targets = elements.map((target, index): DelayedTarget => ({target, delay: typeof delay === 'function' ? delay(index, count) : delay}));
        const referenceDuration = count ? Math.max(...targets.map(target => target.delay)) + calcReferenceDuration(duration, repeat) : 0;

        return new AnimationPlanner(definition.stopsByProperty, targets, timing, referenceDuration);
    }

    plan(sequenceStart: Seconds): AnimationPlan | undefined {
        if (this.targets.length === 0) return undefined;
        const start = sequenceStart + this.localStart;
        return {
            type: 'animation',
            stopsByProperty: this.stopsByProperty,
            easing: this.timing.easing,
            targets: this.targets.map(({target, delay}) => ({target, start: start + delay})),
            start,
            iterationDuration: this.timing.duration,
            ...this.timing.repeat
        };
    }
}

/** A sequence lasts until the latest end among its entries, which is also its duration for positions. */
class SequencePlanner extends Planner {
    private constructor(
        private readonly entries: ReadonlyMap<string, Planner>,
        private readonly iterationDuration: Seconds
    ) {
        super(iterationDuration);
    }

    /** Makes a planner for each entry, and positions it once, among the entries before it. */
    static of(definition: SequenceDefinition, resolveTargets: TargetsResolver): SequencePlanner {
        const entries = new Map<string, Planner>();
        const referenceSpans = new Map<string, Span>();
        definition.timing.entries.forEach(({name, position}, index) => {
            const planner = entryPlannerOf(definition.entries[index]!, resolveTargets).position(position, referenceSpans);
            referenceSpans.set(name, planner.referenceSpan);
            entries.set(name, planner);
        });

        const iterationDuration = Math.max(0, ...[...referenceSpans.values()].map(({start, duration}) => start + duration));
        return new SequencePlanner(entries, iterationDuration);
    }

    /** Plans each entry in it, from where it starts, leaving out the ones that have no plan; `undefined` when none has one. */
    plan(sequenceStart: Seconds): SequencePlan | undefined {
        const start = sequenceStart + this.localStart;
        const entries = new Map<string, Plan>();
        for (const [name, planner] of this.entries) {
            const entryPlan = planner.plan(start);
            if (entryPlan) entries.set(name, entryPlan);
        }
        if (entries.size === 0) return undefined;
        return {
            type: 'sequence',
            entries,
            start,
            iterationDuration: this.iterationDuration,
            repeatCount: 0,
            repeatDelay: 0
        };
    }
}

function entryPlannerOf(entry: SequenceDefinitionEntry, resolveTargets: TargetsResolver): Planner {
    return 'sequence' in entry ? SequencePlanner.of(entry.sequence, resolveTargets) : AnimationPlanner.of(entry.animation, resolveTargets);
}

/** The iterations and their repeat delays; only the first iteration when it repeats forever. */
function calcReferenceDuration(iterationDuration: Seconds, {repeatCount, repeatDelay}: RepeatDescriptor): Seconds {
    if (repeatCount === Infinity) return iterationDuration;
    return iterationDuration * (repeatCount + 1) + repeatDelay * repeatCount;
}
