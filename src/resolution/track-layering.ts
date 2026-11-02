import type {Seconds} from "../types.ts";
import type {TrackEntry} from "./track-entries.ts";
import type {TrackEntryBuilder} from "./track-entry-builder.ts";
import {currentValueToken} from "./track-values.ts";

/**
 * Track entry builders laid over each other in the order they're added, each over the ones before it.
 * - One that a later one starts with or before, and ends with or after, never shows.
 * - A missing start or end takes the value of the topmost one under it running there, other than the ones it hides.
 *   With none, a start takes the end value of the closest one that ends by it, and an end the start of the closest one that starts once it ends,
 *   the topmost of ties, and when both values are missing, or there's none, they're the current value.
 * - It holds after it ends when it ends, and its end lands on none under it. The last added of the ones that start first holds before it starts.
 */
export class TrackLayering {
    /** In the order they're added; one that never shows is null. */
    private readonly builders: (TrackEntryBuilder | null)[] = [];
    /** Each one whose missing start lands on none, and the closest one that ends by its start. */
    private readonly startNeighbors = new Map<TrackEntryBuilder, TrackEntryBuilder | undefined>();
    /** Each one whose missing end lands on none, and the closest one that starts once it ends. */
    private readonly endNeighbors = new Map<TrackEntryBuilder, TrackEntryBuilder | undefined>();
    /** The last added of the ones that start first. */
    private firstStarting: TrackEntryBuilder | undefined;

    add(builder: TrackEntryBuilder): void {
        this.dropCoveredBy(builder);
        this.offerAsNeighbor(builder);
        this.landStart(builder);
        this.landEnd(builder);
        if (!this.firstStarting || builder.start <= this.firstStarting.start)
            this.firstStarting = builder;
        this.builders.push(builder);
    }

    /** The track entries of the ones that show, in the order they're added, each missing value that waited for a neighbor taking its value. */
    build(): TrackEntry[] {
        for (const [builder, neighbor] of this.startNeighbors)
            builder.assignStart(neighbor?.endValue ?? currentValueToken);
        for (const [builder, neighbor] of this.endNeighbors)
            builder.assignEnd(neighbor?.valueAt(neighbor.start) ?? currentValueToken);
        this.firstStarting?.holdBefore();
        return this.builders.filter(builder => builder !== null).map(builder => builder.build());
    }

    /** Each one `top` covers never shows, and nothing lands on it. */
    private dropCoveredBy(top: TrackEntryBuilder): void {
        this.builders.forEach((below, index) => {
            if (below && covers(top, below))
                this.builders[index] = null;
        });
    }

    /** Makes `builder` the neighbor of each waiting one it's as close to as its neighbor so far, or closer, so the last added of ties wins. */
    private offerAsNeighbor(builder: TrackEntryBuilder): void {
        for (const [waiting, neighbor] of this.startNeighbors) {
            if (replacesStartNeighbor(builder, waiting, neighbor))
                this.startNeighbors.set(waiting, builder);
        }
        for (const [waiting, neighbor] of this.endNeighbors) {
            if (replacesEndNeighbor(builder, waiting, neighbor))
                this.endNeighbors.set(waiting, builder);
        }
    }

    /** A missing start takes the value of the topmost one it's inside; with none, it waits for its closest neighbor. */
    private landStart(builder: TrackEntryBuilder): void {
        const landing = this.landingAt(builder.start);
        if (landing)
            builder.assignStart(landing.valueAt(builder.start));
        else if (builder.hasMissingStart)
            this.startNeighbors.set(builder, this.closestBelow(builder, replacesStartNeighbor));
    }

    /** A missing end takes the value of the topmost one it's inside; with none, it holds after it ends, if it ends, and a missing end waits for its closest neighbor. */
    private landEnd(builder: TrackEntryBuilder): void {
        const landing = this.landingAt(builder.end);
        if (landing)
            builder.assignEnd(landing.valueAt(builder.end));
        else {
            if (builder.ends)
                builder.holdAfter();
            if (builder.hasMissingEnd)
                this.endNeighbors.set(builder, this.closestBelow(builder, replacesEndNeighbor));
        }
    }

    /** The topmost one `time` is inside. */
    private landingAt(time: Seconds): TrackEntryBuilder | undefined {
        return this.builders.findLast((below): below is TrackEntryBuilder => below !== null && below.start <= time && time < below.end);
    }

    /** The closest of the ones under `builder` by `replaces`, the topmost of ties. */
    private closestBelow(builder: TrackEntryBuilder, replaces: NeighborTest): TrackEntryBuilder | undefined {
        let closest: TrackEntryBuilder | undefined;
        for (const below of this.builders) {
            if (below && replaces(below, builder, closest))
                closest = below;
        }
        return closest;
    }
}

/** Whether `candidate` takes the place of `current` as `builder`'s closest neighbor on one side: as close as it, or closer, so the later of ties wins. */
type NeighborTest = (candidate: TrackEntryBuilder, builder: TrackEntryBuilder, current: TrackEntryBuilder | undefined) => boolean;

/** It ends by `builder`'s start, and as late as `current`, or later. */
function replacesStartNeighbor(candidate: TrackEntryBuilder, builder: TrackEntryBuilder, current: TrackEntryBuilder | undefined): boolean {
    return candidate.end <= builder.start && (!current || candidate.end >= current.end);
}

/** It starts once `builder` ends, and as early as `current`, or earlier. */
function replacesEndNeighbor(candidate: TrackEntryBuilder, builder: TrackEntryBuilder, current: TrackEntryBuilder | undefined): boolean {
    return candidate.start >= builder.end && (!current || candidate.start <= current.start);
}

/** Whether `top` starts with or before `below`, and ends with or after it. */
function covers(top: TrackEntryBuilder, below: TrackEntryBuilder): boolean {
    return top.start <= below.start && below.end <= top.end;
}
