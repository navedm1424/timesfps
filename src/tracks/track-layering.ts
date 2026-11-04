import {resolveMissingValues} from "./missing-values.ts";
import type {TrackEntry} from "./track-entries.ts";
import type {TrackEntryBuilder} from "./track-entry-builder.ts";

/** The builders that show once `top` is laid over them: the ones it covers never show. */
export function laidOver(showing: readonly TrackEntryBuilder[], top: TrackEntryBuilder): TrackEntryBuilder[] {
    return [...showing.filter(below => !top.covers(below)), top];
}

/**
 * The track entries of builders laid over each other in the order they're given, each over the ones before it: the ones that show, in that order.
 * The ones that show take their missing values from each other, and hold:
 * - after it ends, one that ends with none under it running there;
 * - before it starts, the topmost of the ones that start first.
 */
export function layeredEntriesOf(builders: readonly TrackEntryBuilder[]): TrackEntry[] {
    const showing = builders.reduce<TrackEntryBuilder[]>(laidOver, []);
    resolveMissingValues(showing);

    if (showing.length)
        showing.reduce((first, builder) => builder.start <= first.start ? builder : first).holdBefore();
    const under: TrackEntryBuilder[] = [];
    showing.forEach(builder => {
        if (builder.ends && !under.some(below => below.runsAt(builder.end)))
            builder.holdAfter();
        under.push(builder);
    });
    return showing.map(builder => builder.build());
}
