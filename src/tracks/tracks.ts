import {type ByElementAndProperty, mapByElementAndProperty} from "../dom/mapping.ts";
import type {EntryPath, Naming} from "../naming.ts";
import type {Seconds} from "../types.ts";
import {getOrInsertComputed} from "../utils/collections.ts";
import type {AnimationPlan, PlanNode, SequencePlan} from "../plan.ts";
import type {TrackEntry} from "./track-entries.ts";
import {type RawTrackEntry, TrackEntryAssembler} from "./track-entry-assembler.ts";
import type {PlayTiming} from "./track-entry-builder.ts";
import {layeredEntriesOf} from "./track-layering.ts";

/** Its entries in the order they show over each other in: by when they start, then in the order they're declared; a merged entry's continuations of what in it repeats forever come right under it. */
export type Track = readonly TrackEntry[];

/** Each target's tracks by property: what every animation leaf plays on it, laid out in time. */
export type Tracks = ByElementAndProperty<Track>;

/** Lays its plan out in tracks, naming their entries by `naming`. */
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
    private addNode(node: PlanNode, ancestors: readonly PlayTiming[], path?: EntryPath): void {
        const start = (ancestors.at(-1)?.start ?? 0) + node.position;
        if (node.type === 'sequence')
            this.addSequence(node, start, ancestors, path);
        else
            this.addAnimation(node, start, ancestors, path);
    }

    /** Adds its entries in their order, with the timings of the sequences around them: the ones around it, the outermost first, then its own, which starts `start` after the outermost definition starts. */
    private addSequence({entries, iterationDuration, repeatOptions}: SequencePlan, start: Seconds, ancestors: readonly PlayTiming[], path?: EntryPath): void {
        const timing: PlayTiming = {start, duration: iterationDuration, repeatOptions};
        const entryAncestors = [...ancestors, timing];
        for (const [name, entryPlan] of entries)
            this.addNode(entryPlan, entryAncestors, this.naming.entryPathOf(path, name));
    }

    /** Adds a play of each property on each target, `start` and the target's delay after the outermost definition starts. */
    private addAnimation({stopsByProperty, easing, iterationDuration, repeatOptions, targets}: AnimationPlan, start: Seconds, ancestors: readonly PlayTiming[], path?: EntryPath): void {
        for (const {target, delay} of targets) {
            for (const [property, stops] of Object.entries(stopsByProperty))
                this.trackBuilderOf(target, property).add({path, start: start + delay, duration: iterationDuration, easing, stops, repeatOptions, ancestors});
        }
    }

    private trackBuilderOf(target: Element, property: string): TrackBuilder {
        const buildersByProperty = getOrInsertComputed(this.buildersByTarget, target, () => ({}));
        return buildersByProperty[property] ??= new TrackBuilder(this.assembler);
    }
}

/** The entries that animate one property of one target, built into its track once they're all added. */
class TrackBuilder {
    private readonly entries: RawTrackEntry[] = [];

    constructor(private readonly assembler: TrackEntryAssembler) {}

    add(entry: RawTrackEntry): void {
        this.entries.push(entry);
    }

    /** Lays the entries' builders over each other in stacking order, and builds the track entries of the ones that show. */
    build(): Track {
        return layeredEntriesOf(this.assembler.assemble(this.entries));
    }
}
