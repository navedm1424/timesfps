import {resolveMissingValues} from "./missing-values.ts";
import type {TrackRunBuilder} from "./track-run-builder.ts";
import type {TrackRun} from "./track-runs.ts";
import type {TrackValue} from "./track-values.ts";

/** The builders that show once `top` is laid over them: the ones it covers never show. */
export function laidOver(showing: readonly TrackRunBuilder[], top: TrackRunBuilder): TrackRunBuilder[] {
    return [...showing.filter(below => !top.covers(below)), top];
}

/**
 * The track runs of builders laid over each other in the order they're given, each over the ones before it: the ones that show, in that order.
 * The ones that show take their missing values from each other, and hold:
 * - after it ends, one that ends with none under it running there;
 * - before it starts, the topmost of the ones that start first.
 */
export function layeredRunsOf(builders: readonly TrackRunBuilder[]): TrackRun<TrackValue>[] {
    const showing = builders.reduce<TrackRunBuilder[]>(laidOver, []);
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
