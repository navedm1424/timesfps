import {resolveMissingValues} from "./missing-values.ts";
import {TrackRunBuilder} from "./track-run-builder.ts";
import type {TrackRun, TrackRunTiming} from "./track-runs.ts";
import type {TrackValue} from "./track-values.ts";

/** The builders that show once `top` is laid over them: the ones it covers never show. */
export function layOver(showing: readonly TrackRunBuilder[], top: TrackRunBuilder): TrackRunBuilder[] {
    return [...showing.filter(below => !top.covers(below)), top];
}

/**
 * The track runs of builders laid over each other in the order they're given, each over the ones before it: the ones that show, in that order.
 * The ones that show take their missing values from each other, and hold:
 * - after it ends, one that ends with none under it running there;
 * - before it starts, the topmost of the ones that start first.
 */
export function layer(builders: readonly TrackRunBuilder[]): TrackRun<TrackValue>[] {
    const showing = builders.reduce<TrackRunBuilder[]>(layOver, []);
    resolveMissingValues(showing);

    if (showing.length)
        showing.reduce((first, builder) => builder.start <= first.start ? builder : first).holdBefore();
    const under: TrackRunBuilder[] = [];
    showing.forEach(builder => {
        if (builder.ends && !under.some(below => below.runsAt(builder.end)))
            builder.holdAfter();
        under.push(builder);
    });
    return showing.map(builder => builder.build());
}

/**
 * The builder of a repeating sequence's iteration that repeats as `timing` does: the builders that show, laid over each other in stacking order,
 * each over the ones before it, their missing values taken as they layer, merged into it (`TrackRunBuilder.fromChildren`).
 * A missing start that nothing ends by, or a missing end that nothing starts after, stays missing. Throws without builders.
 */
export function merge(name: string | undefined, timing: TrackRunTiming, builders: readonly TrackRunBuilder[]): TrackRunBuilder {
    const showing = builders.reduce<TrackRunBuilder[]>(layOver, []);
    resolveMissingValues(showing);
    return TrackRunBuilder.fromChildren(name, timing, showing);
}
