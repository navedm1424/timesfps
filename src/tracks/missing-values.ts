import type {Seconds} from "../types.ts";
import type {TrackEntryBuilder} from "./track-entry-builder.ts";
import {currentValueToken} from "./track-values.ts";

/** Gives each missing start and end of the builders, laid over each other in the order they're given, the value it takes. */
export function resolveMissingValues(builders: readonly TrackEntryBuilder[]): void {
    new MissingValuesResolver(builders).resolve();
}

/**
 * Resolves the missing values of track entry builders laid over each other, each over the ones before it.
 * - A missing start or end takes the value of the topmost one under it running there.
 * - With none, a start takes the end value of the closest one that ends by it, and an end the start of the closest one that starts once it ends,
 *   the topmost of ties. When that value is missing too, both are the current value. One without such a neighbor stays missing.
 */
class MissingValuesResolver {
    /** The ones laid so far, in stacking order. */
    private readonly builders: TrackEntryBuilder[] = [];
    /** Each one whose missing start lands on none, and the closest one that ends by its start. */
    private readonly startNeighbors = new Map<TrackEntryBuilder, TrackEntryBuilder | undefined>();
    /** Each one whose missing end lands on none, and the closest one that starts once it ends. */
    private readonly endNeighbors = new Map<TrackEntryBuilder, TrackEntryBuilder | undefined>();

    /** Lays the builders over each other in the order they're given: each missing start or end takes the value it lands on, or waits for its closest neighbor. */
    constructor(builders: readonly TrackEntryBuilder[]) {
        for (const builder of builders)
            this.add(builder);
    }

    /** Gives each missing value that waits its neighbor's value, or the current value when the neighbor's is missing too. */
    resolve(): void {
        this.assignNeighborValues();
        this.assignCurrentValues();
    }

    private add(builder: TrackEntryBuilder): void {
        this.offerAsNeighbor(builder);
        this.landStart(builder);
        this.landEnd(builder);
        this.builders.push(builder);
    }

    /** Makes `builder` the neighbor of each waiting one it's as close to as its neighbor so far, or closer, so the topmost of ties wins. */
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

    /** A missing start takes the value of the topmost one it lands on; with none, it waits for its closest neighbor. */
    private landStart(builder: TrackEntryBuilder): void {
        const landing = this.landingAt(builder.start);
        if (landing)
            builder.assignStartValue(landing.valueAt(builder.start));
        else if (builder.hasMissingStartValue)
            this.startNeighbors.set(builder, this.closestBelow(builder, replacesStartNeighbor));
    }

    /** A missing end takes the value of the topmost one it lands on; with none, it waits for its closest neighbor. */
    private landEnd(builder: TrackEntryBuilder): void {
        const landing = this.landingAt(builder.end);
        if (landing)
            builder.assignEndValue(landing.valueAt(builder.end));
        else if (builder.hasMissingEndValue)
            this.endNeighbors.set(builder, this.closestBelow(builder, replacesEndNeighbor));
    }

    private assignNeighborValues(): void {
        for (const [builder, neighbor] of this.startNeighbors)
            if (neighbor) builder.assignStartValue(neighbor.endValue);
        for (const [builder, neighbor] of this.endNeighbors)
            if (neighbor) builder.assignEndValue(neighbor.valueAt(neighbor.start));
    }

    /** A value still missing after its neighbor's, because the neighbor's is missing too, takes the current value. */
    private assignCurrentValues(): void {
        for (const [builder, neighbor] of this.startNeighbors)
            if (neighbor && builder.hasMissingStartValue) builder.assignStartValue(currentValueToken);
        for (const [builder, neighbor] of this.endNeighbors)
            if (neighbor && builder.hasMissingEndValue) builder.assignEndValue(currentValueToken);
    }

    /** The topmost one running at `time`. */
    private landingAt(time: Seconds): TrackEntryBuilder | undefined {
        return this.builders.findLast(below => below.runsAt(time));
    }

    /** The closest of the ones under `builder` by `replaces`, the topmost of ties. */
    private closestBelow(builder: TrackEntryBuilder, replaces: NeighborTest): TrackEntryBuilder | undefined {
        let closest: TrackEntryBuilder | undefined;
        for (const below of this.builders) {
            if (replaces(below, builder, closest))
                closest = below;
        }
        return closest;
    }
}

/** Whether `candidate` takes the place of `closest` as `builder`'s closest neighbor on one side: as close as it, or closer, so the topmost of ties wins. */
type NeighborTest = (candidate: TrackEntryBuilder, builder: TrackEntryBuilder, closest: TrackEntryBuilder | undefined) => boolean;

/** It ends by `builder`'s start, and as late as `closest`, or later. */
function replacesStartNeighbor(candidate: TrackEntryBuilder, builder: TrackEntryBuilder, closest: TrackEntryBuilder | undefined): boolean {
    return candidate.end <= builder.start && (!closest || candidate.end >= closest.end);
}

/** It starts once `builder` ends, and as early as `closest`, or earlier. */
function replacesEndNeighbor(candidate: TrackEntryBuilder, builder: TrackEntryBuilder, closest: TrackEntryBuilder | undefined): boolean {
    return candidate.start >= builder.end && (!closest || candidate.start <= closest.start);
}
