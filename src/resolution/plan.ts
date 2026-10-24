import type {AnimationDefinition} from "../animation.ts";
import {type EntrySpan, type PositionDescriptor, resolvePosition} from "../at.ts";
import {type Target} from "../dom/mapping.ts";
import type {Easing} from "../easing.ts";
import type {RepeatOptions} from "../playback-options.ts";
import {type Definition, SequenceDefinition, type SequenceDefinitionEntry} from "../sequence.ts";
import {resolveTransition} from "../transition.ts";
import type {Seconds} from "../types.ts";

/** Times are local to the sequence an entry is in, or start at 0 for the outermost definition. */
interface EntryPlan {
    /** Where it starts, before its delay; what `<` refers to. */
    position: Seconds;
    /** How long one play of an animation, or a sequence, lasts, without delays or repeats; an animation with no targets takes no time. */
    playDuration: Seconds;
}

/** A target of an animation, with the animation's own delay for it. */
export interface StaggeredTarget {
    target: Element;
    delay: Seconds;
}

export interface AnimationPlan extends EntryPlan {
    type: 'animation';
    definition: AnimationDefinition;
    /** The easing one play runs. */
    easing: Easing;
    targets: readonly StaggeredTarget[];
}

export interface SequencePlan extends EntryPlan {
    type: 'sequence';
    definition: SequenceDefinition;
    entries: ReadonlyMap<string, PlanNode>;
}

export type PlanNode = AnimationPlan | SequencePlan;

type TargetsResolver = (target: Target) => readonly Element[];

/** Resolves the definition's targets, and places every entry, and every target of each, in time. */
export function plan(definition: AnimationDefinition, resolveTargets: TargetsResolver): AnimationPlan;
export function plan(definition: SequenceDefinition, resolveTargets: TargetsResolver): SequencePlan;
export function plan(definition: Definition, resolveTargets: TargetsResolver): PlanNode;
export function plan(definition: Definition, resolveTargets: TargetsResolver): PlanNode {
    return definition instanceof SequenceDefinition
        ? SequencePlanner.of(definition, resolveTargets).plan()
        : AnimationPlanner.of(definition, resolveTargets).plan();
}

/** Plans an entry from its definition, which gives its duration, then its position among the entries before it. */
abstract class EntryPlanner {
    protected entryPosition: Seconds = 0;

    protected constructor(
        /** Its duration for positions, from its position to where `>` refers to: its delay and repeats included, of which an infinite repeat counts its first play only. */
        protected readonly anchorDuration: Seconds
    ) {}

    /** Resolves its position among the entries before it, clamped to the start of the sequence. */
    position(descriptor: PositionDescriptor<string>, entrySpans: ReadonlyMap<string, EntrySpan>): this {
        this.entryPosition = Math.max(0, resolvePosition(descriptor, entrySpans, this.anchorDuration));
        return this;
    }

    get span(): EntrySpan {
        return {start: this.entryPosition, duration: this.anchorDuration};
    }

    abstract plan(): PlanNode;
}

class AnimationPlanner extends EntryPlanner {
    private constructor(
        private readonly definition: AnimationDefinition,
        private readonly targets: readonly Element[],
        /** Each target's own delay. */
        private readonly delays: readonly Seconds[],
        private readonly playDuration: Seconds,
        anchorDuration: Seconds,
        private readonly easing: Easing
    ) {
        super(anchorDuration);
    }

    static of(definition: AnimationDefinition, resolveTargets: TargetsResolver): AnimationPlanner {
        const targets = resolveTargets(definition.target);
        const count = targets.length;

        const {delay = 0, ...repeatOptions} = definition.timing.playback;
        const delays = targets.map((_, index) => typeof delay === 'function' ? delay(index, count) : delay);

        const {duration, easing} = resolveTransition(definition.timing.transition);
        const playDuration = count ? duration : 0;
        const anchorDuration = count ? Math.max(...delays) + anchoredPlaysDuration(playDuration, repeatOptions) : 0;

        return new AnimationPlanner(definition, targets, delays, playDuration, anchorDuration, easing);
    }

    plan(): AnimationPlan {
        return {
            type: 'animation',
            definition: this.definition,
            easing: this.easing,
            targets: this.targets.map((target, index): StaggeredTarget => ({target, delay: this.delays[index]!})),
            position: this.entryPosition,
            playDuration: this.playDuration
        };
    }
}

/** A sequence lasts until the latest end among its entries, which is also its duration for positions. */
class SequencePlanner extends EntryPlanner {
    private constructor(
        private readonly definition: SequenceDefinition,
        private readonly entries: ReadonlyMap<string, PlanNode>,
        private readonly playDuration: Seconds
    ) {
        super(playDuration);
    }

    /** Plans each entry once, at its position among the entries before it. */
    static of(definition: SequenceDefinition, resolveTargets: TargetsResolver): SequencePlanner {
        const entries = new Map<string, PlanNode>();
        const entrySpans = new Map<string, EntrySpan>();
        definition.timing.entries.forEach(({name, position}, index) => {
            const planner = entryPlannerOf(definition.entries[index]!, resolveTargets).position(position, entrySpans);
            entrySpans.set(name, planner.span);
            entries.set(name, planner.plan());
        });

        const playDuration = Math.max(0, ...[...entrySpans.values()].map(({start, duration}) => start + duration));
        return new SequencePlanner(definition, entries, playDuration);
    }

    plan(): SequencePlan {
        return {
            type: 'sequence',
            definition: this.definition,
            entries: this.entries,
            position: this.entryPosition,
            playDuration: this.playDuration
        };
    }
}

function entryPlannerOf(entry: SequenceDefinitionEntry, resolveTargets: TargetsResolver): EntryPlanner {
    return 'sequence' in entry ? SequencePlanner.of(entry.sequence, resolveTargets) : AnimationPlanner.of(entry.animation, resolveTargets);
}

/** The plays and their repeat delays; only the first play when it repeats forever. */
function anchoredPlaysDuration(playDuration: Seconds, {repeat = 0, repeatDelay = 0}: RepeatOptions): Seconds {
    if (repeat === Infinity) return playDuration;
    return playDuration * (repeat + 1) + repeatDelay * repeat;
}
