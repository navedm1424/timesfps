import {resolveMissingValues} from "./missing-values.ts";
import type {TrackEntryBuilder} from "./track-entry-builder.ts";

/** The builders that show once `top` is laid over them: the ones it covers never show. */
function layOver(showing: readonly TrackEntryBuilder[], top: TrackEntryBuilder): TrackEntryBuilder[] {
    return [...showing.filter(below => !top.covers(below)), top];
}

/**
 * The builders that show once laid over each other in the order they're given, each over the ones before it, in that order.
 * They take their missing values from each other; a missing start that nothing ends by, or a missing end that nothing starts after, stays missing.
 */
export function layer(builders: readonly TrackEntryBuilder[]): TrackEntryBuilder[] {
    const showing = builders.reduce<TrackEntryBuilder[]>(layOver, []);
    resolveMissingValues(showing);
    return showing;
}

/**
 * Makes builders laid over each other in the order they're given, all of which show, hold:
 * - after it ends, one that ends with none under it running there;
 * - before it starts, the topmost of the ones that start first, when `firstHoldsBefore`.
 */
export function resolveHolds(builders: readonly TrackEntryBuilder[], {firstHoldsBefore = true}: { firstHoldsBefore?: boolean } = {}): void {
    if (firstHoldsBefore && builders.length)
        builders.reduce((first, builder) => builder.start <= first.start ? builder : first).holdBefore();
    const under: TrackEntryBuilder[] = [];
    builders.forEach(builder => {
        if (builder.ends && !under.some(below => below.runsAt(builder.end)))
            builder.holdAfter();
        under.push(builder);
    });
}
