import {type ByElementAndProperty, mapByElementAndProperty} from "../dom/mapping.ts";
import type {EntryPath, Naming} from "../naming.ts";
import type {RepeatOptions} from "../playback-options.ts";
import type {Seconds} from "../types.ts";
import {getOrInsertComputed} from "../utils/collections.ts";
import type {AnimationPlan, PlanNode, SequencePlan} from "../plan.ts";
import {type TrackEntry, TrackEntryAssembler} from "./track-entry-assembler.ts";
import {layeredRunsOf} from "./track-layering.ts";
import type {Oscillation, TrackRun, TrackRunTiming} from "./track-runs.ts";
import type {TrackValue} from "./track-values.ts";

/** Its runs in the order they show over each other in: by when they start, then in the order they're declared; a merged run's continuations of what in it repeats forever come right under it. */
export type Track = readonly TrackRun<TrackValue>[];

/** Each target's tracks by property: what every animation leaf plays on it, laid out in time. */
export type Tracks = ByElementAndProperty<Track>;

/** Lays its plan out in tracks, naming their runs by `naming`. */
export class TracksResolver {
    private readonly buildersByTarget = new Map<Element, { [property: string]: TrackBuilder }>();
    private readonly assembler: TrackEntryAssembler;

    constructor(private readonly plan: PlanNode, private readonly naming: Naming) {
        this.assembler = new TrackEntryAssembler(naming);
    }

    /** Adds every animation leaf of the plan to its targets' track builders, then builds them. */
    resolve(): Tracks {
        this.addNode(this.plan, []);
        return mapByElementAndProperty(this.buildersByTarget, builder => builder.build());
    }

    /** Adds an animation or a sequence, which starts at its position after the start of the sequence it's in. */
    private addNode(node: PlanNode, ancestors: readonly TrackRunTiming[], path?: EntryPath): void {
        const start = (ancestors.at(-1)?.start ?? 0) + node.position;
        if (node.type === 'sequence')
            this.addSequence(node, start, ancestors, path);
        else
            this.addAnimation(node, start, ancestors, path);
    }

    /** Adds its entries in their order, with the timings of the sequences around them: the ones around it, the outermost first, then its own, which starts `start` after the outermost definition starts. */
    private addSequence({entries, iterationDuration, repeatOptions}: SequencePlan, start: Seconds, ancestors: readonly TrackRunTiming[], path?: EntryPath): void {
        const entryAncestors = [...ancestors, trackRunTimingOf(start, iterationDuration, repeatOptions)];
        for (const [name, entryPlan] of entries)
            this.addNode(entryPlan, entryAncestors, this.naming.entryPathOf(path, name));
    }

    /** Adds a run of each property on each target, `start` and the target's delay after the outermost definition starts. */
    private addAnimation({stopsByProperty, easing, iterationDuration, repeatOptions, targets}: AnimationPlan, start: Seconds, ancestors: readonly TrackRunTiming[], path?: EntryPath): void {
        for (const {target, delay} of targets) {
            const timing = trackRunTimingOf(start + delay, iterationDuration, repeatOptions);
            for (const [property, stops] of Object.entries(stopsByProperty))
                this.trackBuilderOf(target, property).add({path, ...timing, easing, stops, ancestors});
        }
    }

    private trackBuilderOf(target: Element, property: string): TrackBuilder {
        const buildersByProperty = getOrInsertComputed(this.buildersByTarget, target, () => ({}));
        return buildersByProperty[property] ??= new TrackBuilder(this.assembler);
    }
}

/** The run of what starts at `start` and repeats iterations of `duration` as `repeatOptions` say; one without duration doesn't repeat. */
function trackRunTimingOf(start: Seconds, duration: Seconds, {repeat = 0, repeatDelay = 0, repeatMode = 'loop'}: RepeatOptions): TrackRunTiming {
    if (duration === 0 || repeat === 0) return {start, duration, repeatCount: 0, repeatDelay: 0};
    const oscillate: Oscillation | undefined = repeatMode === 'reverse' ? 'time' : repeatMode === 'mirror' ? 'values' : undefined;
    return {start, duration, repeatCount: repeat, repeatDelay, ...(oscillate && {oscillate})};
}

/** The entries that animate one property of one target, built into its track once they're all added. */
class TrackBuilder {
    private readonly entries: TrackEntry[] = [];

    constructor(private readonly assembler: TrackEntryAssembler) {}

    add(entry: TrackEntry): void {
        this.entries.push(entry);
    }

    /** Lays the entries' builders over each other in stacking order, and builds the track runs of the ones that show. */
    build(): Track {
        return layeredRunsOf(this.assembler.assemble(this.entries));
    }
}
